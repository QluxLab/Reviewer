import OpenAI from "openai";
import { Config } from "../config";
import { processDiff } from "../utils";

export interface AIReviewResponse {
  summary: string;
  comments: Array<{
    file: string;
    line: number;
    body: string;
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
      "body": "comment text"
    }
  ]
}

IMPORTANT:
- The diff provided to you includes line numbers for each line of code.
- The 'line' in your response MUST be the exact line number shown in the diff corresponding to the code you are commenting on.
- Only comment on lines that are changed in the diff (lines starting with '+').
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
      console.log("AI Parsed Response:", JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      console.error("Error calling AI service:", error);
      throw error;
    }
  }
}
