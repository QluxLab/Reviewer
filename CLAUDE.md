# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a GitHub Action called "QLux Code Reviewer" - an AI-powered code review tool that integrates with GitHub Pull Requests using OpenAI-compatible APIs. The project is written in TypeScript and compiled to JavaScript for deployment as a GitHub Action.

## Key Development Commands

### Build and Development
```bash
# Install dependencies
npm install

# Build the action (bundles TypeScript into single JavaScript file)
npm run build

# Format code with Prettier
npm run format
```

### Testing and Validation
- **No dedicated test framework** exists in this project
- Manual testing through GitHub Actions workflow
- Input validation occurs in runtime configuration
- Error handling is distributed throughout the codebase

### Local Development Workflow
1. Modify TypeScript files in `src/`
2. Run `npm run build` to compile changes
3. Test via GitHub Actions integration or manual testing

## Codebase Architecture

### Core Architecture Pattern
- **Service-Oriented Architecture**: Clear separation of concerns with dedicated services
- **Event-Driven Workflow**: Responds to GitHub events (`pull_request`, `issue_comment`, `pull_request_review_comment`)
- **TypeScript-First**: Full type safety with strict configuration

### Main Components

#### Entry Point
- **`src/main.ts`**: Main orchestrator handling GitHub events and workflow coordination

#### Services Directory (`src/services/`)
- **`github.ts`**: GitHub API interactions and PR management
- **`ai.ts`**: AI service for code review generation and OpenAI API communication

#### Configuration
- **`src/config.ts`**: Runtime configuration management with validation
- **`action.yml`**: GitHub Action metadata and input parameters

#### Utilities
- **`src/utils.ts`**: Helper functions for file filtering, comment parsing, and severity handling

### Event Handling Flow
1. **Event Detection**: Listens for `pull_request` (opened/synchronize), `issue_comment` (created), and `pull_request_review_comment` (created) events
2. **Validation**: Checks event types and comment parsing (`/review` commands)
3. **File Processing**: Fetches changed files, applies ignore patterns
4. **AI Integration**: Sends diffs to OpenAI API, processes structured responses
5. **Result Posting**: Posts summary comments and creates inline review comments
6. **Comment Management**: Deletes outdated comments and handles user replies

## File Structure and Organization

```
src/
├── main.ts              # Main entry point and workflow orchestrator
├── config.ts           # Configuration management
├── utils.ts            # Utility functions and helpers
└── services/
    ├── github.ts       # GitHub API service
    └── ai.ts           # AI service for code review
```

## Key Data Models and Interfaces

### Configuration (`src/config.ts`)
```typescript
interface Config {
  openaiApiKey: string;
  openaiBaseUrl: string;
  model: string;
  githubToken: string;
  systemMessage: string;
  ignorePatterns: string[];
  minSeverity: SeverityLevel;
  disableInline: boolean;
}
```

### AI Review Response
```typescript
interface AIReviewResponse {
  summary: string;
  comments: Array<{
    file: string;
    line: number;
    body: string;
    severity: SeverityLevel;
  }>;
  deleteCommentIds?: number[];
}
```

### Severity Levels
- `low`, `medium`, `high`, `critical` - Used for comment filtering and prioritization
- Mapped to GitHub Alert syntax:
  - `critical` → `> [!CAUTION]`
  - `high` → `> [!WARNING]`
  - `medium` → `> [!IMPORTANT]`
  - `low` → `> [!TIP]` or `> [!NOTE]`

## AI Integration Features

- **Multi-provider Support**: OpenAI, Azure, vLLM, Ollama, and other OpenAI-compatible APIs
- **JSON Response Format**: Structured AI output for consistent processing
- **Line Number Accuracy**: Uses diff parsing for precise comment placement
- **Severity Filtering**: Configurable minimum severity levels for comments
- **Interactive Mode**: Handles user replies to AI comments with context-aware responses
- **Comment Management**: AI can delete its own outdated comments via function calling

### AI Prompt Structure
The AI service uses a comprehensive system prompt that guides the model to:
1. Analyze code for security, performance, code quality, architecture, and testing issues
2. Provide structured output with summary and inline comments
3. Use GitHub Alert syntax for severity levels
4. Maintain consistency with previous reviews
5. Manage comment lifecycle (delete outdated comments)

## File Processing Pipeline

- **Glob Pattern Matching**: Configurable file ignore patterns via `minimatch`
- **Diff Parsing**: Uses `parse-diff` library for accurate line numbers
- **Performance Considerations**: Handles large PRs by processing all files at once

## Key Development Considerations

### Security
- API keys handled through environment variables
- Input validation for all GitHub Action inputs
- File pattern filtering prevents processing sensitive files
- Bot detection to avoid infinite loops in comment replies

### Error Handling
- Comprehensive try-catch blocks throughout the workflow
- GitHub Actions core utilities for logging and error reporting
- Graceful degradation when AI service is unavailable
- Fallback mechanisms for comment thread fetching

### Extensibility Points
- **AI Provider**: Easy to add new OpenAI-compatible providers
- **File Processing**: Additional filtering and transformation logic
- **Comment Formatting**: Custom comment templates and styling
- **Event Handling**: Support for additional GitHub events

## Configuration Management

### Required Inputs (via action.yml)
- `openai_api_key`: API key for AI service
- `github_token`: GitHub token for API access

### Optional Inputs
- `model`: AI model selection (default: 'gpt-4o')
- `openai_base_url`: Custom API endpoint (default: 'https://api.openai.com/v1')
- `system_message`: Custom AI instructions
- `ignore_patterns`: File filtering patterns (default: 'package-lock.json,yarn.lock,dist/**,*.svg')
- `min_severity`: Minimum comment severity level (default: 'low')
- `disable_inline`: Disable inline comments generation (default: 'false')

## Build System

### Compilation
- Uses `@vercel/ncc` to bundle TypeScript into single JavaScript file
- Output: `dist/index.js` (executed by GitHub Actions)
- Strict TypeScript configuration with full type checking

### Dependencies
- **Runtime**: `@actions/core`, `@actions/github`, `openai`, `parse-diff`, `minimatch`
- **Build**: `@vercel/ncc`, `typescript`, `prettier`

## Development Environment Setup

1. **Node.js**: Ensure Node.js is installed (check package.json for version requirements)
2. **Dependencies**: Run `npm install` to install all dependencies
3. **Configuration**: Set up required environment variables for testing
4. **Code Style**: Prettier is configured for consistent formatting

## Common Development Tasks

### Adding New Features
1. Add TypeScript implementation in appropriate service file
2. Update configuration interfaces if needed
3. Modify main orchestrator to integrate new functionality
4. Rebuild with `npm run build`

### Debugging
- Use GitHub Actions core logging functions (`core.info`, `core.debug`, `core.warning`)
- Add console.log statements during development (removed in production)
- Test with various PR scenarios and comment types

### Performance Optimization
- Consider diff chunking for large PRs (TODO in main.ts)
- Optimize AI response parsing for better error handling
- Implement caching for repeated operations where appropriate

## Usage Patterns

### Manual Trigger
To trigger a review manually or with specific instructions, comment on the PR:

**Standard Trigger**
```text
/review
```

**Custom Instructions**
```text
/review Focus on security vulnerabilities and performance optimizations.
```

### Interactive Reviews
Users can reply to AI-generated comments. The system detects the reply, reads the conversation thread, and provides a contextual response.

### Automatic Reviews
The action automatically runs on:
- New Pull Requests (`opened` event)
- Updated Pull Requests (`synchronize` event)
- Issue comments containing `/review` command

## GitHub Action Workflow Example

```yaml
name: AI Review

permissions:
  contents: read
  pull-requests: write
  issues: write

on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: AI Code Reviewer
        uses: QluxLab/Reviewer@v1.0.0
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Optional:
          model: 'gpt-4o'
          ignore_patterns: 'package-lock.json, *.svg'
```
