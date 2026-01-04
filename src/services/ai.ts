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
    commentChain: string,
    customInstructions?: string,
  ): Promise<string> {
    const systemPrompt = `
${this.config.systemMessage}

You are replying to a user's comment on a code review.
Your goal is to be helpful, clarify your previous review comments if needed, or acknowledge the user's feedback.
Keep your response concise and professional.
`;

    const userPrompt = `
${customInstructions ? `Additional Instructions: ${customInstructions}\n` : ""}

Context (Code Diff):
${processDiff(diff)}

Comment Chain:
${commentChain}
    `;

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
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

You must respond in valid JSON format with the following schema:
{
  "summary": "Markdown summary of the review",
  "comments": [
    {
      "file": "filename",
      "line": line_number_in_diff,
      "body": "comment text",
      "severity": "low|medium|high|critical"
    }
  ]
}

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
        response_format: { type: "json_object" },
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
