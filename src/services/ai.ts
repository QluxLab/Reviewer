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
    customInstructions?: string,
  ): Promise<AIReviewResponse> {
    const processedDiff = processDiff(diff);
    const systemPrompt = `
${this.config.systemMessage}

IMPORTANT:
- The diff provided to you includes line numbers for each line of code.
- The 'line' in your response MUST be the exact line number shown in the diff corresponding to the code you are commenting on.
- Only comment on lines that are changed in the diff (lines starting with '+').
- Assign a severity level to each comment:
  - 'low': Minor style issues, suggestions, or trivial improvements
  - 'medium': Potential bugs, performance concerns, or moderate issues
  - 'high': Likely bugs, security concerns, or significant problems
  - 'critical': Severe security vulnerabilities, crashes, or blocking issues
- If there are no specific comments, return an empty array for "comments".
`;

    const userPrompt = `
${customInstructions ? `Additional Instructions: ${customInstructions}\n` : ""}

Review the following git diff:
${processedDiff}
    `;

    try {
      console.log(`Sending diff to AI. Length: ${processedDiff.length}`);

      const completion = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "review_response",
            strict: true,
            schema: {
              type: "object",
              properties: {
                summary: {
                  type: "string",
                  description: "Markdown summary of the review",
                },
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
                        description: "The line number in the diff",
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
              },
              required: ["summary", "comments"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = completion.choices[0].message.content;
      if (!content) {
        throw new Error("Empty response from AI");
      }

      const response = JSON.parse(content) as AIReviewResponse;

      // Validate and normalize severity levels
      if (response.comments) {
        const originalCount = response.comments.length;
        response.comments = response.comments.map((comment) => ({
          ...comment,
          severity: this.normalizeSeverity(comment.severity),
        }));

        // Check for comments with invalid severity (normalized to 'low')
        const invalidSeverityCount = response.comments.filter(
          (c) => c.severity === "low",
        ).length;

        if (invalidSeverityCount > 0) {
          core.warning(
            `Found ${invalidSeverityCount} comments with invalid severity levels, defaulting to 'low'`,
          );
        }

        core.info(`Processed ${originalCount} comments with severity levels`);
      }

      console.log("AI Parsed Response:", JSON.stringify(response, null, 2));
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
