# bigj-mcp

Stdio MCP server with the tools for the Big J AI content team (AgentDesk).

## Tools
| Tool | What it does |
|---|---|
| `fb_fetch_candidates(fresh?, limit?)` | Runs the Apify task that scrapes the 3 FB groups. Returns IMAGE posts only in a compact form: post_url, text, image_urls, likes, comments. `fresh:false` reuses the last scrape for free. |
| `image_reverse_prompt(image_url, language?, post_text?)` | Looks at an image with a Grafilab vision model (Gemma 4 31B by default). Returns a prompt that recreates it, plus funny/sexy/creative scores and a safety check. |
| `x_whoami()` | Shows which X account the credentials belong to |
| `x_post_tweet(text, image_url?, reply_to_tweet_id?)` | Posts to X (with an optional image, optionally as a reply for threads). Returns the tweet URL. |

## Env
| Var | Value |
|---|---|
| X_API_KEY / X_API_SECRET | X app API Key and Secret |
| X_ACCESS_TOKEN / X_ACCESS_SECRET | Access Token and Secret. Must be regenerated AFTER you set the app to Read and write. |
| X_USERNAME | `bigj_ai` |
| X_DRY_RUN | `1` = test mode (never posts). Remove it to go live. |
| APIFY_TOKEN | Apify personal API token |
| APIFY_TASK_ID | Apify task ID, e.g. `abc123XYZ`, or `username~bigj-fb-groups` |
| GRAFILAB_API_KEY | Grafilab key |
| GRAFILAB_VISION_MODEL | optional, default `grafilab/gemma-4-31b-it` |

## Run (Node.js 18+)
From GitHub, no SSH needed:
    command: npx
    args:    -y github:<your-github-user>/bigj-mcp

On the VM:
    npm install
    command: node
    args:    /path/to/bigj-mcp/index.js
