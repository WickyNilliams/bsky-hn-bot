#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

// Configuration from environment variables
const config = {
  minScore: parseInt(process.env.MIN_SCORE || '100'),
  postsPerRun: parseInt(process.env.POSTS_PER_RUN || '1'),
  maxStoryAgeHours: parseInt(process.env.MAX_STORY_AGE_HOURS || '48'),
  dryRun: process.env.DRY_RUN === 'true',
  blueskyUsername: process.env.BLUESKY_USERNAME,
  blueskyPassword: process.env.BLUESKY_PASSWORD,
};

// Types
interface Story {
  id: number;
  title: string;
  url: string;
  hnUrl: string;
  score: number;
  publishedAt: Date;
}

interface BotState {
  lastStoryId: number;
}

// Utility functions
function log(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
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

// State management
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

// RSS parsing
async function fetchRSSFeed(): Promise<Story[]> {
  const rssUrl = `https://hnrss.org/frontpage?points=${config.minScore}`;
  
  const response = await fetch(rssUrl);
  if (!response.ok) {
    throw new Error(`RSS fetch failed: ${response.status} ${response.statusText}`);
  }
  
  const rssText = await response.text();
  
  // Parse RSS XML manually (simple approach for HN RSS format)
  const stories: Story[] = [];
  const itemRegex = /<item>(.*?)<\/item>/gs;
  let match;
  
  while ((match = itemRegex.exec(rssText)) !== null) {
    const item = match[1];
    
    // Extract fields using regex
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const commentsMatch = item.match(/<comments>(.*?)<\/comments>/);
    const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
    
    if (!titleMatch || !linkMatch || !commentsMatch || !pubDateMatch) {
      continue;
    }
    
    // Extract story ID from comments URL
    const commentsUrl = commentsMatch[1];
    const idMatch = commentsUrl.match(/item\?id=(\d+)/);
    if (!idMatch) continue;
    
    const id = parseInt(idMatch[1]);
    const title = titleMatch[1];
    const url = linkMatch[1];
    const publishedAt = new Date(pubDateMatch[1]);
    
    // Extract score from title (format: "Title (123 points)")
    const scoreMatch = title.match(/\((\d+) points?\)$/);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    
    // Clean title (remove score suffix)
    const cleanTitle = title.replace(/\s*\(\d+ points?\)$/, '');
    
    stories.push({
      id,
      title: cleanTitle,
      url,
      hnUrl: commentsUrl,
      score,
      publishedAt,
    });
  }
  
  return stories.sort((a, b) => a.id - b.id); // Sort by ID ascending
}

// Bluesky posting
async function postToBluesky(story: Story): Promise<void> {
  if (!config.blueskyUsername || !config.blueskyPassword) {
    throw new Error('Bluesky credentials not configured');
  }
  
  // Create session
  const createSessionResponse = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: config.blueskyUsername,
      password: config.blueskyPassword,
    }),
  });
  
  if (!createSessionResponse.ok) {
    throw new Error(`Bluesky auth failed: ${createSessionResponse.status}`);
  }
  
  const session = await createSessionResponse.json();
  
  // Format post with markdown link for discussion
  const postText = `📰 ${story.title}

🔗 ${story.url}

💬 [Discuss on HN](${story.hnUrl})

#hackernews`;
  
  // Create post
  const postResponse = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        text: postText,
        createdAt: new Date().toISOString(),
      },
    }),
  });
  
  if (!postResponse.ok) {
    const errorText = await postResponse.text();
    throw new Error(`Bluesky post failed: ${postResponse.status} ${errorText}`);
  }
  
  log(`Post successful: "${story.title}" (ID: ${story.id}, Score: ${story.score})`);
}

// Main logic
async function main() {
  log('Starting HN to Bluesky bot');
  log(`Config: minScore=${config.minScore}, maxAge=${config.maxStoryAgeHours}h, dryRun=${config.dryRun}`);
  
  try {
    // Get state file path from command line args
    const stateFile = process.argv[2] || 'last-processed.json';
    log(`Using state file: ${stateFile}`);
    
    // Load state
    const state = loadState(stateFile);
    log(`Current state: lastStoryId=${state.lastStoryId}`);
    
    // Fetch RSS feed with retries
    const stories = await retryWithBackoff(
      fetchRSSFeed,
      3,
      1000,
      'Fetching RSS feed'
    );
    
    log(`Found ${stories.length} stories in RSS feed`);
    
    // Filter new stories
    const newStories = stories.filter(story => story.id > state.lastStoryId);
    log(`Found ${newStories.length} new stories above threshold`);
    
    if (newStories.length === 0) {
      log('No new stories to process');
      return;
    }
    
    // Filter by age
    const now = new Date();
    const maxAgeMs = config.maxStoryAgeHours * 60 * 60 * 1000;
    const freshStories = newStories.filter(story => {
      const ageMs = now.getTime() - story.publishedAt.getTime();
      const ageHours = ageMs / (60 * 60 * 1000);
      
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
      log(`Dry run: Would post "${storyToPost.title}" (ID: ${storyToPost.id}, Score: ${storyToPost.score})`);
    } else {
      log(`Posting story: "${storyToPost.title}" (ID: ${storyToPost.id}, Score: ${storyToPost.score})`);
      
      await retryWithBackoff(
        () => postToBluesky(storyToPost),
        3,
        2000,
        'Posting to Bluesky'
      );
    }
    
    // Update and save state
    state.lastStoryId = storyToPost.id;
    saveState(stateFile, state);
    
  } catch (error) {
    log(`Bot execution failed: ${error.message}`);
    process.exit(1);
  }
}

// Run the bot
main().catch(error => {
  log(`Unhandled error: ${error.message}`);
  process.exit(1);
});
