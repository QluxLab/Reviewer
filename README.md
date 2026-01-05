# QLux Code Reviewer

A GitHub Action that performs AI-powered code reviews on Pull Requests using OpenAI-compatible APIs (OpenAI, Azure, vLLM, Ollama, etc.).

## Features

- **Multi-Trigger Support**: Runs on new/updated Pull Requests, manual `/review` comments, or user replies to AI comments
- **AI-Powered**: Uses OpenAI's GPT models (or compatible) to analyze diffs and provide intelligent feedback
- **Smart Comment Management**: Automatically cleans up outdated comments on new commits and prevents duplicate reviews
- **Detailed Output**: Provides a high-level summary and inline code comments with severity levels
- **Interactive**: Responds to user replies with context-aware explanations
- **Configurable**: Severity filtering, customizable system prompts, ignore patterns, and optional inline comments
- **Threaded Context**: Maintains conversation context when users reply to AI comments

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
        uses: QluxLab/Reviewer@v1.0
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

### 3. Interactive Reviews

Users can reply to AI-generated comments, and the AI will respond with contextual explanations based on the conversation thread.

### 4. Configuration Options

The action supports several configuration options to tailor the review experience:

- **Severity Filtering**: Use `min_severity` to only show comments of a certain importance level (low, medium, high, critical)
- **Inline Comments**: Disable inline comments with `disable_inline: true` if you only want summary reviews
- **File Filtering**: Customize which files to ignore using `ignore_patterns`
- **Model Selection**: Choose different AI models via the `model` parameter

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `openai_api_key` | API Key for OpenAI or compatible service. | **Yes** | N/A |
| `github_token` | GitHub Token (`${{ secrets.GITHUB_TOKEN }}`). | **Yes** | N/A |
| `model` | Model ID to use. | No | `gpt-4o` |
| `openai_base_url` | Base URL for the API. | No | `https://api.openai.com/v1` |
| `system_message` | Custom system prompt for the AI. | No | "You are an expert code reviewer. Provide a summary of changes and inline comments for improvements." |
| `ignore_patterns` | Comma-separated glob patterns to ignore. | No | `package-lock.json,yarn.lock,dist/**,*.svg` |
| `min_severity` | Minimum severity level for comments to be posted (low, medium, high, critical). | No | `low` |
| `disable_inline` | Disable inline comments generation and posting. | No | `false` | |

## Development

1. Install dependencies: `npm install`
2. Build the action: `npm run build`
3. The built artifact is in `dist/index.js`.

### Code Structure

The project follows a service-oriented architecture:

- **`src/main.ts`**: Main orchestrator handling GitHub events and workflow coordination
- **`src/services/github.ts`**: GitHub API interactions and PR management
- **`src/services/ai.ts`**: AI service for code review generation and OpenAI API communication
- **`src/config.ts`**: Runtime configuration management with validation
- **`src/utils.ts`**: Helper functions for file filtering, comment parsing, and severity handling

### Event Flow

1. **Event Detection**: Listens for `pull_request`, `issue_comment`, and `pull_request_review_comment` events
2. **Validation**: Checks event types and comment parsing (`/review` commands)
3. **File Processing**: Fetches changed files, applies ignore patterns
4. **AI Integration**: Sends diffs to OpenAI API, processes structured responses
5. **Result Posting**: Posts summary comments and creates inline review comments
6. **Smart Cleanup**: Automatically removes outdated comments on new commits

### Architecture Features

- **Threaded Context**: Maintains conversation history when users reply to AI comments
- **Severity Filtering**: Configurable minimum severity levels for comments
- **Multi-provider Support**: Works with OpenAI, Azure, vLLM, Ollama, and other compatible APIs
- **JSON Response Format**: Structured AI output for consistent processing
- **Line Number Accuracy**: Uses diff parsing for precise comment placement