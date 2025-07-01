# bsky-hn-bot

A GitHub Actions bot that automatically posts high-scoring Hacker News stories to Bluesky. Runs every 15 minutes with configurable score thresholds and intelligent drip-feed posting.

## How It Works

1. **Fetches** the latest stories from [hnrss.org](https://hnrss.org) with configurable point thresholds
2. **Filters** for new stories since the last run, skipping content older than 48 hours
3. **Posts** one story per run to Bluesky with rich formatting and HN discussion links
4. **Tracks** progress in a JSON state file committed to the repository

The bot uses a drip-feed approach, posting only the oldest unprocessed story each run. This prevents spam while ensuring consistent coverage of high-quality content.

## Features

 **Zero infrastructure costs** - runs entirely on GitHub Actions
- **Configurable thresholds** - set minimum story scores via environment variables
- **Age filtering** - automatically skips stale content after downtime
- **Retry logic** - handles temporary failures gracefully
- **Dry run mode** - test safely without posting
- **Rich formatting**

## Post Format

```
📰 Amazing AI Breakthrough Announced

🔗 https://example.com/article

💬 [Discuss on HN](https://news.ycombinator.com/item?id=12345)
```

## Setup

### 1. Fork This Repository

Click the "Fork" button to create your own copy of this bot.

### 2. Configure Bluesky Credentials

In your fork, go to **Settings → Secrets and variables → Actions** and add:

- `BLUESKY_USERNAME`: Your Bluesky username (e.g. your email `whatever@example.ory`)
- `BLUESKY_PASSWORD`: An app password from your Bluesky account settings

### 3. Create Initial State File

Create `last-processed.json` in the repository root:

```json
{"lastStoryId": 0}
```

### 4. Customize Configuration (Optional)

Edit the `env` section in `.github/workflows/bot.yml`:

```yaml
env:
  MIN_SCORE: 100              # Only post stories with 100+ points
  MAX_STORY_AGE_HOURS: 48     # Skip stories older than 48 hours
  DRY_RUN: false              # Set to true for testing
```

### 5. Enable and Test

- Push your changes to activate the workflow
- Go to **Actions** tab to monitor runs
- Use **Run workflow** button for manual testing

## Local Development

```bash
# Install Node.js 22.6+ then:

# Test without posting
npm run dev

# Test with custom state
npm run test

# Run normally
npm start
```

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_SCORE` | 100 | Minimum story points to post |
| `POSTS_PER_RUN` | 1 | Stories posted per execution (keep at 1) |
| `MAX_STORY_AGE_HOURS` | 48 | Skip stories older than this |
| `DRY_RUN` | false | Test mode - no actual posting |

## Troubleshooting

**Bot not posting?**
- Check Actions tab for error logs
- Verify Bluesky credentials in repository secrets
- Ensure `last-processed.json` exists

**Want to pause the bot?**
- Go to Actions → "HN to Bluesky Bot" → "..." → "Disable workflow"

**Need to reset state?**
- Edit `last-processed.json` to set a different `lastStoryId`
- Or delete the file to start from the beginning

## Architecture

- **Runtime**: Node.js 22+ with experimental TypeScript support
- **Hosting**: GitHub Actions (free for public repos)
- **Data**: Simple JSON state file committed to git
- **Dependencies**: Zero - uses only Node.js built-ins

## License

MIT
