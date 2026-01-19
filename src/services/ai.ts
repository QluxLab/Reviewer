import OpenAI from "openai";
import { Config } from "../config";
import { processDiff } from "../utils";
import * as core from "@actions/core";

export type SeverityLevel = "low" | "medium" | "high" | "critical";

export interface AIReviewResponse {
  summary: string;
  comments: Array<{
    file: string;
    line: number;
    body: string;
    severity: SeverityLevel;
  }>;
  deleteCommentIds?: number[];
  minimizeCommentIds?: number[];
}

export class AIService {
  private openai: OpenAI;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.openai = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
    });
  }

  async generateReply(
    diff: string,
    threadComments: Array<{ author: string; body: string; isBot: boolean }>,
    customInstructions?: string,
  ): Promise<string> {
    const systemPrompt = `
${this.config.systemMessage}

You are replying to a user's comment on a code review.
Your goal is to be helpful, clarify your previous review comments if needed, or acknowledge the user's feedback.
Keep your response concise and professional.
`;

    // Construct the threaded context
    const processedDiff = processDiff(diff);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `I am reviewing this code change:\n\n${processedDiff}`,
      },
    ];

    // Add conversation history as proper messages
    threadComments.forEach((comment) => {
      messages.push({
        role: comment.isBot ? "assistant" : "user",
        content: comment.isBot
          ? comment.body
          : `${comment.author}: ${comment.body}`,
      });
    });

    if (customInstructions) {
      messages.push({
        role: "system",
        content: `Additional Instructions: ${customInstructions}`,
      });
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: messages,
      });

      const content = completion.choices[0].message.content;
      if (!content) {
        throw new Error("Empty response from AI");
      }
      return content;
    } catch (error) {
      console.error("Error generating reply:", error);
      throw error;
    }
  }

  async getReview(
    diff: string,
    existingComments: Array<{
      id: number;
      body: string;
      path?: string;
      line?: number;
      type: "issue" | "review";
      isOutdated: boolean;
      isSummary?: boolean;
      isMinimized?: boolean;
    }>,
    previousSummaries: Array<string>,
    customInstructions?: string,
  ): Promise<AIReviewResponse> {
    const processedDiff = processDiff(diff);

    // Separate active review comments (bot's previous reviews) from other comments
    const previousReviews = existingComments.filter(
      (c) => c.type === "review" && !c.isOutdated && !c.isMinimized
    );

    // Get outdated but not minimized comments
    const outdatedComments = existingComments.filter(
      (c) => c.type === "review" && c.isOutdated && !c.isMinimized
    );

    const systemPrompt = `
## Role

You're a senior software engineer conducting a thorough code review. Provide constructive, actionable feedback.

## Review Areas

Analyze the selected code for:

1. **Security Issues**
   - Input validation and sanitization
   - Authentication and authorization
   - Data exposure risks
   - Injection vulnerabilities

2. **Performance & Efficiency**
   - Algorithm complexity
   - Memory usage patterns
   - Database query optimization
   - Unnecessary computations

3. **Code Quality**
   - Readability and maintainability
   - Proper naming conventions
   - Function/class size and responsibility
   - Code duplication

4. **Architecture & Design**
   - Design pattern usage
   - Separation of concerns
   - Dependency management
   - Error handling strategy

5. **Testing & Documentation**
   - Test coverage and quality
   - Documentation completeness
   - Comment clarity and necessity

## Output Format

**For the main summary:**
Provide a brief, high-level overview of what this PR does and your overall assessment. Keep it concise (2-4 sentences). DO NOT include detailed issues or suggestions here - those go in inline comments.

Example:
"This PR implements user authentication using JWT tokens. The overall approach is solid, but there are some security concerns and performance optimizations that should be addressed before merging."

**For inline comments:**
Use GitHub Alert syntax to categorize your feedback by severity:

- **> [!CAUTION]** - Critical security issues or bugs that must be fixed before merge
- **> [!WARNING]** - Important issues that should be addressed (performance problems, design flaws)
- **> [!IMPORTANT]** - Significant improvements that are strongly recommended
- **> [!TIP]** - Helpful suggestions for better code quality or maintainability
- **> [!NOTE]** - Minor observations, good practices spotted, or informational comments

For each inline comment:
- Start with the appropriate alert syntax
- Provide a clear explanation of the issue/suggestion
- Include a code example if applicable
- Explain the rationale

Example inline comment:
\`\`\`
> [!CAUTION]
> SQL injection vulnerability detected. User input is directly interpolated into the query string.
> 
> Replace with parameterized query:
> \`\`\`javascript
> db.query('SELECT * FROM users WHERE id = ?', [userId])
> \`\`\`
> This prevents malicious SQL from being executed.
\`\`\`

Focus on: ${customInstructions || "General code improvements and best practices"}

Be constructive and educational in your feedback.

IMPORTANT IMPLEMENTATION DETAILS:
- The diff provided to you includes line numbers for each line of code.
- Only comment on lines that are changed in the diff (lines starting with '+').
- Use the available tools to submit the review.
- For inline comments (using the 'comments' tool parameter), map the GitHub Alert to severity as follows:
  - **> [!CAUTION]** -> 'critical'
  - **> [!WARNING]** -> 'high'
  - **> [!IMPORTANT]** -> 'medium'
  - **> [!TIP]** -> 'low'
  - **> [!NOTE]** -> 'low'
- Always start inline comment body with the appropriate alert syntax (e.g., "> [!CAUTION]")
- Be precise and confident in your feedback. Avoid vague language.
- Directly state the issue and the solution.

IMPORTANT - COMMENT MANAGEMENT:
- You are provided with a list of "existing comments" on the PR.
- Some comments are marked as 'isOutdated: true'. This means they were made on a previous commit and the code line has since changed.
- GitHub automatically collapses these outdated comments, but you can also MINIMIZE them to hide them completely.
- DO NOT report the same issue again if it was already reported in an outdated comment, UNLESS the issue persists in the new code.
- If an issue persists, you SHOULD report it again on the new line.
- EXISTING ACTIVE COMMENTS (isOutdated: false, isMinimized: false): Do NOT report these again. We want to avoid duplicate comments on the same line.

COMMENT ACTIONS AVAILABLE:
1. **delete_comment** - Permanently delete a comment (use sparingly, only for mistakes)
2. **minimize_comment** - Hide/collapse a comment as OUTDATED (preferred for old comments that are no longer relevant)

When to use minimize vs delete:
- MINIMIZE: When an old comment is no longer relevant due to code changes (preferred approach)
- DELETE: Only when a comment was posted by mistake or is completely invalid

CONSISTENCY WITH PREVIOUS REVIEWS:
- You have access to your previous review comments below.
- Maintain consistency with your previous feedback - don't contradict yourself.
- If you previously recommended a pattern/approach, don't suggest the opposite now unless the context has significantly changed.
- If the developer addressed your previous comment, acknowledge it and don't repeat the same issue.
- Build upon your previous reviews - if you see the same pattern elsewhere, reference your earlier feedback.
${previousSummaries.length > 0 ? `
- You also have access to your previous summary comments to maintain context across reviews.
- Consider what was mentioned in previous summaries when writing the new one.
- If issues from previous summaries are now resolved, acknowledge that progress.
` : ''}
`;

    const userPrompt = `
${customInstructions ? `Additional Instructions: ${customInstructions}\n` : ""}

Review the following git diff:
${processedDiff}

Here are your existing comments on this PR:
${JSON.stringify(existingComments, null, 2)}

${previousReviews.length > 0 ? `
YOUR PREVIOUS REVIEW COMMENTS (for context and consistency):
${previousReviews.map((c) => `[${c.path}:${c.line}] ${c.body}`).join("\n\n")}

Remember to stay consistent with your previous feedback.
` : ""}

${outdatedComments.length > 0 ? `
OUTDATED COMMENTS (consider minimizing these):
${outdatedComments.map((c) => `ID: ${c.id} - [${c.path}:${c.line || 'unknown'}] ${c.body.substring(0, 100)}...`).join("\n")}

These comments are outdated because the code has changed. Consider using minimize_comment tool to hide them.
` : ""}

${previousSummaries.length > 0 ? `
YOUR PREVIOUS REVIEW SUMMARIES (for context):
${previousSummaries.map((summary, i) => `--- Review #${i + 1} ---\n${summary}`).join("\n\n")}

Use this context to write a comprehensive summary that builds upon previous reviews.
If issues mentioned in previous summaries are now resolved, acknowledge that progress.
` : ""}

Use the available tools to submit your review and manage comments.
    `;

    // Define tools
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "delete_comment",
          description: "Permanently delete an existing comment. Use ONLY when a comment was posted by mistake or is completely invalid. For outdated comments, prefer minimize_comment instead.",
          parameters: {
            type: "object",
            properties: {
              comment_id: {
                type: "integer",
                description: "The ID of the comment to delete",
              },
            },
            required: ["comment_id"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "minimize_comment",
          description: "Hide/collapse a comment by marking it as OUTDATED. This is the preferred way to handle comments that are no longer relevant due to code changes. The comment will still be visible in the 'Show resolved' view.",
          parameters: {
            type: "object",
            properties: {
              comment_id: {
                type: "integer",
                description: "The ID of the comment to minimize",
              },
            },
            required: ["comment_id"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "submit_review",
          description: "Submit the code review with a summary and optional inline comments. The summary should be a brief overview of the PR (2-4 sentences). Detailed feedback goes in inline comments using GitHub Alert syntax.",
          parameters: {
            type: "object",
            properties: {
              summary: {
                type: "string",
                description: "Brief markdown summary of what this PR does and overall assessment (2-4 sentences). DO NOT include detailed issues here. Return ONLY the summary, nothing else.",
              },
              // Only include 'comments' field if inline comments are NOT disabled
              ...(!this.config.disableInline
                ? {
                  comments: {
                    type: "array",
                    description: "List of inline comments using GitHub Alert syntax",
                    items: {
                      type: "object",
                      properties: {
                        file: {
                          type: "string",
                          description: "The file path",
                        },
                        line: {
                          type: "number",
                          description: "The line number in the diff (must be a line starting with +)",
                        },
                        body: {
                          type: "string",
                          description: "The comment text starting with GitHub Alert syntax (e.g., '> [!CAUTION]\\n> Description...')",
                        },
                        severity: {
                          type: "string",
                          enum: ["low", "medium", "high", "critical"],
                          description: "Severity level: 'critical' for CAUTION, 'high' for WARNING, 'medium' for IMPORTANT, 'low' for TIP/NOTE",
                        },
                      },
                      required: ["file", "line", "body", "severity"],
                      additionalProperties: false,
                    },
                  },
                }
                : {}),
            },
            required: this.config.disableInline ? ["summary"] : ["summary", "comments"],
            additionalProperties: false,
          },
        },
      },
    ];

    try {
      console.log(`Sending diff to AI. Length: ${processedDiff.length}`);

      const completion = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: tools,
        tool_choice: "required", // Force the model to call at least one tool
      });

      const response: AIReviewResponse = {
        summary: "",
        comments: [],
        deleteCommentIds: [],
        minimizeCommentIds: [],
      };

      const toolCalls = completion.choices[0].message.tool_calls;

      if (toolCalls) {
        for (const toolCall of toolCalls) {
          const args = JSON.parse(toolCall.function.arguments);

          if (toolCall.function.name === "delete_comment") {
            response.deleteCommentIds!.push(args.comment_id);
          } else if (toolCall.function.name === "minimize_comment") {
            response.minimizeCommentIds!.push(args.comment_id);
          } else if (toolCall.function.name === "submit_review") {
            response.summary = args.summary;
            if (args.comments) {
              response.comments = args.comments.map((c: any) => ({
                ...c,
                severity: this.normalizeSeverity(c.severity),
              }));
            }
          }
        }
      }

      // If submit_review wasn't called (unlikely with tool_choice: required, but possible if model loops on deletes), handle gracefully
      if (!response.summary && !response.deleteCommentIds?.length && !response.minimizeCommentIds?.length) {
        // Fallback or warning could go here, but for now we trust the model to behave
        core.warning("AI did not submit a review summary.");
      }

      return response;
    } catch (error) {
      console.error("Error calling AI service:", error);
      throw error;
    }
  }

  private normalizeSeverity(severity: string): SeverityLevel {
    const lower = severity.toLowerCase().trim();
    if (["low", "medium", "high", "critical"].includes(lower)) {
      return lower as SeverityLevel;
    }
    // Default to 'low' for invalid severity values
    return "low";
  }
}