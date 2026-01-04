import * as github from '@actions/github';
import * as core from '@actions/core';
import { GitHub } from '@actions/github/lib/utils';

export class GitHubService {
  private octokit: InstanceType<typeof GitHub>;
  private context: typeof github.context;

  constructor(token: string) {
    this.octokit = github.getOctokit(token);
    this.context = github.context;
  }

  get repo() {
    return this.context.repo;
  }

  async getPullRequestDiff(prNumber: number): Promise<string> {
    const { data: diff } = await this.octokit.rest.pulls.get({
      ...this.repo,
      pull_number: prNumber,
      mediaType: {
        format: 'diff',
      },
    });
    // @ts-ignore - The type definition doesn't always reflect that data is string for mediaType diff
    return diff as string;
  }

  async postComment(prNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      ...this.repo,
      issue_number: prNumber,
      body,
    });
  }

  async createReview(prNumber: number, comments: Array<{ path: string; line: number; body: string }>): Promise<void> {
    if (comments.length === 0) return;

    await this.octokit.rest.pulls.createReview({
      ...this.repo,
      pull_number: prNumber,
      event: 'COMMENT',
      comments: comments.map(c => ({
        path: c.path,
        line: c.line,
        body: c.body,
      })),
    });
  }

  async getChangedFiles(prNumber: number): Promise<string[]> {
    const { data: files } = await this.octokit.rest.pulls.listFiles({
      ...this.repo,
      pull_number: prNumber,
    });
    return files.map(f => f.filename);
  }
  
  async getPRDetails(prNumber: number) {
      const { data: pr } = await this.octokit.rest.pulls.get({
          ...this.repo,
          pull_number: prNumber
      });
      return pr;
  }
}