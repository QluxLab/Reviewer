import OpenAI from 'openai';
import { Config } from '../config';

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

  async getReview(diff: string, customInstructions?: string): Promise<AIReviewResponse> {
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
- The 'line' must be the line number in the new version of the file.
- Only comment on lines that are changed in the diff.
- If there are no specific comments, return an empty array for "comments".
`;

    const userPrompt = `
${customInstructions ? `Additional Instructions: ${customInstructions}\n` : ''}

Review the following git diff:
${diff}
    `;

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      });

      const content = completion.choices[0].message.content;
      if (!content) {
        throw new Error('Empty response from AI');
      }

      return JSON.parse(content) as AIReviewResponse;
    } catch (error) {
      console.error('Error calling AI service:', error);
      throw error;
    }
  }
}