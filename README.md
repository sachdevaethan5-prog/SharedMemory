# Shared Memory

One memory that all your AI assistants share. Tell Claude something, and ChatGPT knows it
too. It is a small MCP server that runs on your own free Cloudflare account, so the data
stays yours.

It holds three things:

- **Memory**: lasting facts about you (preferences, people, schedules, projects).
- **Tasks**: things you need to do, with due dates, a next step and a dated log.
- **Bills**: what you owe and when.

One file of code, no dependencies, no AI calls of its own, so running it costs nothing on
Cloudflare's free plan.

## Tools

| Tool | What it does |
| --- | --- |
| `memory_save` | Save a fact. Refuses exact duplicates and tasks. Can be marked as a guess or given an end date. |
| `memory_search` | Find facts by keywords. |
| `memory_list` | List facts, newest first, optionally by category. |
| `memory_update` | Change one field of a fact, or just mark it as still true. |
| `memory_delete` | Forget a fact. |
| `memory_recent` | The newest things across memory, tasks and bills, with how long ago. This is what an assistant calls when you say "the thing I just saved" in a different chat. |
| `task_add`, `task_list`, `task_get`, `task_update` | Your to-do list. |
| `bill_add`, `bill_list`, `bill_update` | Your bills. |

## Setup (about 5 minutes)

You need a free Cloudflare account and Node 22 or newer.

```bash
git clone https://github.com/sachdevaethan5-prog/SharedMemory.git
cd SharedMemory
npx wrangler login
npx wrangler d1 create shared-memory
```

Copy the `database_id` it prints into `wrangler.toml`, and set `TIMEZONE` there. Then:

```bash
npx wrangler d1 execute shared-memory --remote --file schema.sql
npx wrangler secret put MEMORY_KEY
npx wrangler deploy
```

For `MEMORY_KEY`, type a long random string (40 or more letters and digits). It is the
password to your memory.

Your connector URL is:

```
https://shared-memory.<your-subdomain>.workers.dev/mcp/<MEMORY_KEY>
```

## Connect your assistants

- **Claude**: Settings, Connectors, Add custom connector, paste the URL.
- **ChatGPT**: Settings, Connectors (developer mode), add an MCP server with the URL.
- **Anything else that speaks MCP** over HTTP: point it at the same URL.

Start a new chat and say "remember that I prefer window seats". Open the other assistant
and ask "what did I just save?".

## Security

- The key in the URL is the only lock. Anyone with the URL can read and change everything,
  so treat the whole URL like a password and never post it.
- To change the key, run `npx wrangler secret put MEMORY_KEY` again and update each
  connector.
- The tools tell assistants never to store passwords, card numbers or other secrets. That
  is an instruction, not a guarantee, so do not dictate secrets to it.
- Back up with `npx wrangler d1 export shared-memory --remote --output backup.sql`.

## Test

```bash
node --test
```

No network, no account needed.

## Versions

See [CHANGELOG.md](CHANGELOG.md). First number: a permission changed. Second: a new
ability. Third: a fix.

## License

MIT. See [LICENSE](LICENSE). Free to use, change and share, including commercially, as long
as the license text stays with it. It comes with no warranty.

This is an independent project, not affiliated with or endorsed by Anthropic, OpenAI or
Cloudflare. Claude, ChatGPT and Cloudflare are trademarks of their owners.
