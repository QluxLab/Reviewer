# AI Code Reviewer Action

A GitHub Action that performs AI-powered code reviews on Pull Requests using OpenAI-compatible APIs (OpenAI, Azure, vLLM, Ollama, etc.).

## Features

- **Dual Trigger**: Runs on new/updated Pull Requests OR via `/review` comment on a PR.
- **AI-Powered**: Uses OpenAI's GPT models (or compatible) to analyze diffs.
- **Detailed Output**: Provides a high-level summary and inline code comments for specific improvements.
- **Customizable**: Configurable system prompts, ignore patterns, and per-run instructions.

## Usage

### 1. Basic Workflow

Create a file `.github/workflows/ai-review.yml` in your repository:

```yaml
name: AI Review

permissions:
  contents: read
  pull-requests: write
  issues: write # Required for comment reactions

on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: AI Code Reviewer
        uses: ./ # Or your-username/ai-pr-reviewer@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Optional inputs
          # model: 'gpt-4o'
          # openai_base_url: 'https://api.openai.com/v1'
          # system_message: 'Custom system prompt...'
          # ignore_patterns: 'package-lock.json, *.svg'
```

### 2. Manual Trigger

To trigger a review manually (or with custom instructions), comment on a PR:

```
/review
```

Or with instructions:

```
/review Focus on security vulnerabilities and performance optimizations.
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `openai_api_key` | API Key for OpenAI or compatible service. | **Yes** | N/A |
| `github_token` | GitHub Token (`${{ secrets.GITHUB_TOKEN }}`). | **Yes** | N/A |
| `model` | Model ID to use. | No | `gpt-4o` |
| `openai_base_url` | Base URL for the API. | No | `https://api.openai.com/v1` |
| `system_message` | Custom system prompt for the AI. | No | (Default Code Reviewer Prompt) |
| `ignore_patterns` | Comma-separated glob patterns to ignore. | No | `package-lock.json,yarn.lock,dist/**,*.svg` |

## Development

1. Install dependencies: `npm install`
2. Build the action: `npm run build`
3. The built artifact is in `dist/index.js`.