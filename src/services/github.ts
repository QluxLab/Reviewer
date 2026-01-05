import * as github from "@actions/github";
import * as core from "@actions/core";
import { GitHub } from "@actions/github/lib/utils";

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
        format: "diff",
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

  async createReview(
    prNumber: number,
    comments: Array<{ path: string; line: number; body: string }>,
  ): Promise<void> {
    if (comments.length === 0) return;

    await this.octokit.rest.pulls.createReview({
      ...this.repo,
      pull_number: prNumber,
      event: "COMMENT",
      comments: comments.map((c) => ({
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
    return files.map((f) => f.filename);
  }

  async getPRDetails(prNumber: number) {
    const { data: pr } = await this.octokit.rest.pulls.get({
      ...this.repo,
      pull_number: prNumber,
    });
    return pr;
  }

  async getAuthenticatedUser() {
    // Strictly return github-actions[bot] as requested
    return {
      login: "github-actions[bot]",
      id: -1,
    } as any;
  }

  async listComments(prNumber: number) {
    const { data: comments } = await this.octokit.rest.issues.listComments({
      ...this.repo,
      issue_number: prNumber,
    });
    return comments;
  }

  async deleteComment(commentId: number) {
    await this.octokit.rest.issues.deleteComment({
      ...this.repo,
      comment_id: commentId,
    });
  }

  async listReviewComments(prNumber: number) {
    const { data: comments } = await this.octokit.rest.pulls.listReviewComments({
      ...this.repo,
      pull_number: prNumber,
    });
    return comments;
  }

  async listBotComments(prNumber: number): Promise<
    Array<{ id: number; body: string; path?: string; line?: number; type: "issue" | "review" }>
  > {
    const botUser = await this.getAuthenticatedUser();
    const result: Array<{
      id: number;
      body: string;
      path?: string;
      line?: number;
      type: "issue" | "review";
    }> = [];

    // 1. Issue Comments (General)
    const issueComments = await this.listComments(prNumber);
    for (const comment of issueComments) {
      if (comment.user?.login === botUser.login) {
        result.push({
          id: comment.id,
          body: comment.body || "",
          type: "issue",
        });
      }
    }

    // 2. Review Comments (Inline)
    const reviewComments = await this.listReviewComments(prNumber);
    for (const comment of reviewComments) {
      if (comment.user?.login === botUser.login) {
        result.push({
          id: comment.id,
          body: comment.body,
          path: comment.path,
          line: comment.line || comment.original_line || undefined,
          type: "review",
        });
      }
    }

    return result;
  }

  async deleteReviewComment(commentId: number) {
    await this.octokit.rest.pulls.deleteReviewComment({
      ...this.repo,
      comment_id: commentId,
    });
  }

  async createReply(prNumber: number, commentId: number, body: string) {
    await this.octokit.rest.pulls.createReplyForReviewComment({
      ...this.repo,
      pull_number: prNumber,
      comment_id: commentId,
      body,
    });
  }

  async getCommentThread(prNumber: number, commentId: number): Promise<Array<{author: string; body: string; isBot: boolean}>> {
    try {
      // Fetch the specific comment to get its position in the thread
      const { data: comment } = await this.octokit.rest.pulls.getReviewComment({
        ...this.repo,
        pull_number: prNumber,
        comment_id: commentId,
      });

      // Get all review comments for the PR
      const { data: allComments } = await this.octokit.rest.pulls.listReviewComments({
        ...this.repo,
        pull_number: prNumber,
      });

      // Find comments in the same thread (same file, same position, same commit)
      const threadComments = allComments.filter(c =>
        c.path === comment.path &&
        c.position === comment.position &&
        c.commit_id === comment.commit_id
      );

      // Sort by created_at to get chronological order
      threadComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      // Get authenticated user to identify bot comments
      const botUser = await this.getAuthenticatedUser();

      // Format thread data
      return threadComments.map(c => ({
        author: c.user?.login || 'Unknown',
        body: c.body,
        isBot: c.user?.login === botUser.login
      }));
    } catch (error) {
      core.warning(`Failed to fetch comment thread: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Return empty array on failure, caller can handle gracefully
      return [];
    }
  }
}
