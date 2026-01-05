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
    }>,
    customInstructions?: string,
  ): Promise<AIReviewResponse> {
    const processedDiff = processDiff(diff);
    const systemPrompt = `
${this.config.systemMessage}

IMPORTANT:
- The diff provided to you includes line numbers for each line of code.
- Only comment on lines that are changed in the diff (lines starting with '+').
- Assign a severity level to each comment:
  - 'low': Minor style issues, suggestions, or trivial improvements
  - 'medium': Potential bugs, performance concerns, or moderate issues
  - 'high': Likely bugs, security concerns, or significant problems
  - 'critical': Severe security vulnerabilities, crashes, or blocking issues
- You can delete your old comments if they are no longer relevant (e.g., the issue was fixed).
`;

    const userPrompt = `
${customInstructions ? `Additional Instructions: ${customInstructions}\n` : ""}

Review the following git diff:
${processedDiff}

Here are your existing comments on this PR:
${JSON.stringify(existingComments, null, 2)}

Use the available tools to submit your review and manage comments.
    `;

    // Define tools
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "delete_comment",
          description: "Delete an existing comment that is no longer valid or relevant.",
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
          name: "submit_review",
          description: "Submit the code review with a summary and optional inline comments.",
          parameters: {
            type: "object",
            properties: {
              summary: {
                type: "string",
                description: "Markdown summary of the review",
              },
              // Only include 'comments' field if inline comments are NOT disabled
              ...(!this.config.disableInline
                ? {
                    comments: {
                      type: "array",
                      description: "List of inline comments",
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
                            description: "The comment text",
                          },
                          severity: {
                            type: "string",
                            enum: ["low", "medium", "high", "critical"],
                            description: "Severity level of the issue",
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
      };

      const toolCalls = completion.choices[0].message.tool_calls;

      if (toolCalls) {
        for (const toolCall of toolCalls) {
          const args = JSON.parse(toolCall.function.arguments);

          if (toolCall.function.name === "delete_comment") {
            response.deleteCommentIds!.push(args.comment_id);
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
      if (!response.summary && !response.deleteCommentIds?.length) {
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
