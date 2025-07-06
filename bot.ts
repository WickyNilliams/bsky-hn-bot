#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { BskyAgent, RichText } from '@atproto/api';

const config = {
  minScore: parseInt(process.env.MIN_SCORE || '100'),
  maxStoryAgeHours: parseInt(process.env.MAX_STORY_AGE_HOURS || '48'),
  dryRun: process.env.DRY_RUN === 'true',
  blueskyUsername: process.env.BLUESKY_USERNAME,
  blueskyPassword: process.env.BLUESKY_PASSWORD,
};

interface Story {
  id: number;
  title: string;
  url: string;
  hnUrl: string;
  publishedAt: Date;
}

interface BotState {
  lastStoryId: number;
}

function log(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function extractStoryId(itemId: string | undefined): number | null {
  if (!itemId) return null;
  
  try {
    const url = new URL(itemId);
    const storyIdParam = url.searchParams.get('id');
    if (!storyIdParam) return null;
    
    const storyId = parseInt(storyIdParam);
    return isNaN(storyId) ? null : storyId;
  } catch (error) {
    return null;
  }
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  operationName: string
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log(`${operationName} (attempt ${attempt}/${maxAttempts})`);
      return await operation();
    } catch (error) {
      lastError = error as Error;
      log(`${operationName} failed (attempt ${attempt}/${maxAttempts}): ${error.message}`);
      
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  throw lastError!;
}

function loadState(filepath: string): BotState {
  try {
    const content = readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    log('No previous state found, starting from scratch');
    return { lastStoryId: 0 };
  }
}

function saveState(filepath: string, state: BotState): void {
  writeFileSync(filepath, JSON.stringify(state, null, 2));
  log(`State saved: lastStoryId = ${state.lastStoryId}`);
}

async function fetchRSSFeed(): Promise<Story[]> {
  const jsonUrl = `https://hnrss.org/newest.jsonfeed?points=${config.minScore}`;
  
  const response = await fetch(jsonUrl);
  if (!response.ok) {
    throw new Error(`JSON feed fetch failed: ${response.status} ${response.statusText}`);
  }
  
  const jsonData = await response.json();
  const stories: Story[] = [];
  
  for (const item of jsonData.items || []) {
    const id = extractStoryId(item.id);
    if (id === null) continue;
    const title = item.title || '';
    const url = item.url || '';
    const publishedAt = new Date(item.date_published || item.date_modified || Date.now());
    
    stories.push({
      id,
      title,
      url,
      hnUrl: item.id,
      publishedAt,
    });
  }
  
  return stories.sort((a, b) => a.id - b.id); // Sort by ID ascending
}

async function postToBluesky(story: Story): Promise<void> {
  if (!config.blueskyUsername || !config.blueskyPassword) {
    throw new Error('Bluesky credentials not configured');
  }
  
  const agent = new BskyAgent({
    service: 'https://bsky.social',
  });
  
  await agent.login({
    identifier: config.blueskyUsername,
    password: config.blueskyPassword,
  });
  
  const postText = `📰 ${story.title}

🔗 ${story.url}

💬 Discuss on HN`;

  // Create RichText object to handle links properly
  const richText = new RichText({
    text: postText,
  });
  await richText.detectFacets(agent);
  
  // Manually add facet for "Discuss on HN" link
  const discussText = "Discuss on HN";
  const discussStart = postText.lastIndexOf(discussText);
  const discussEnd = discussStart + discussText.length;
  
  // Convert string positions to UTF-8 byte positions
  const textEncoder = new TextEncoder();
  const beforeDiscuss = postText.slice(0, discussStart);
  const byteStart = textEncoder.encode(beforeDiscuss).length;
  const byteEnd = textEncoder.encode(postText.slice(0, discussEnd)).length;
  
  // Add the HN discussion link facet
  if (!richText.facets) richText.facets = [];
  richText.facets.push({
    index: {
      byteStart,
      byteEnd,
    },
    features: [{
      $type: 'app.bsky.richtext.facet#link',
      uri: story.hnUrl,
    }],
  });

  await agent.post({
    text: richText.text,
    facets: richText.facets,
  });
  
  log(`Post successful: "${story.title}" (ID: ${story.id})`);
}

async function main() {
  log('Starting HN to Bluesky bot');
  log(`Config: minScore=${config.minScore}, maxAge=${config.maxStoryAgeHours}h, dryRun=${config.dryRun}`);
  
  try {
    const stateFile = process.argv[2] || 'last-processed.json';
    log(`Using state file: ${stateFile}`);
    
    const state = loadState(stateFile);
    log(`Current state: lastStoryId=${state.lastStoryId}`);
    
    const stories = await retryWithBackoff(
      fetchRSSFeed,
      3,
      1000,
      'Fetching RSS feed'
    );
    
    log(`Found ${stories.length} stories in RSS feed`);
    
    const newStories = stories.filter(story => story.id > state.lastStoryId);
    log(`Found ${newStories.length} new stories above threshold`);
    
    if (newStories.length === 0) {
      log('No new stories to process');
      return;
    }
    
    const now = new Date();
    const maxAgeMs = config.maxStoryAgeHours * 60 * 60 * 1000;
    const freshStories = newStories.filter(story => {
      const ageMs = now.getTime() - story.publishedAt.getTime();
      const ageHours = ageMs / (60 * 60 * 1000);
      
      log(`Story ID ${story.id}: published ${story.publishedAt.toISOString()}, age: ${ageHours.toFixed(1)}h`);
      
      if (ageMs > maxAgeMs) {
        log(`Skipping story ID ${story.id} (age: ${ageHours.toFixed(1)}h, max: ${config.maxStoryAgeHours}h)`);
        return false;
      }
      
      return true;
    });
    
    log(`Found ${freshStories.length} fresh stories within age limit`);
    
    if (freshStories.length === 0) {
      // Skip old stories by advancing to latest ID
      const latestId = Math.max(...newStories.map(s => s.id));
      log(`All stories too old, advancing to latest ID: ${latestId}`);
      state.lastStoryId = latestId;
      saveState(stateFile, state);
      return;
    }
    
    // Post oldest story (drip-feed approach)
    const storyToPost = freshStories[0];
    
    if (config.dryRun) {
      log(`Dry run: Would post "${storyToPost.title}" (ID: ${storyToPost.id})`);
      log('Dry run: State not updated');
    } else {
      log(`Posting story: "${storyToPost.title}" (ID: ${storyToPost.id})`);
      
      await retryWithBackoff(
        () => postToBluesky(storyToPost),
        3,
        2000,
        'Posting to Bluesky'
      );
      
      state.lastStoryId = storyToPost.id;
      saveState(stateFile, state);
    } 
  } catch (error) {
    log(`Bot execution failed: ${error.message}`);
    process.exit(1);
  }
}

main().catch(error => {
  log(`Unhandled error: ${error.message}`);
  process.exit(1);
});
