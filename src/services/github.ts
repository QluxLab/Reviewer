import * as github from "@actions/github";
import * as core from "@actions/core";

export interface BotComment {
  id: number;
  body: string;
  isSummary: boolean;
  isOutdated: boolean;      // <-- Добавлено
  isMinimized?: boolean;    // <-- Добавлено
  type: 'issue' | 'review';
  path?: string;
  line?: number;
  createdAt?: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity: string;
}

export interface ThreadComment {
  author: string;
  body: string;
  isBot: boolean;
}

export class GitHubService {
  private octokit: ReturnType<typeof github.getOctokit>;
  private owner: string;
  private repo: string;

  constructor(token: string) {
    this.octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * Get list of changed files in a PR
   */
  async getChangedFiles(prNumber: number): Promise<string[]> {
    const files: string[] = [];
    let page = 1;

    while (true) {
      const response = await this.octokit.rest.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });

      for (const file of response.data) {
        files.push(file.filename);
      }

      if (response.data.length < 100) break;
      page++;
    }

    return files;
  }

  /**
   * Get PR diff
   */
  async getPullRequestDiff(prNumber: number): Promise<string> {
    const response = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      mediaType: {
        format: "diff",
      },
    });

    return response.data as unknown as string;
  }

  /**
   * Get PR head SHA
   */
  async getPRHeadSHA(prNumber: number): Promise<string> {
    const response = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    return response.data.head.sha;
  }

  /**
   * Post a general comment on PR
   */
  async postComment(prNumber: number, body: string): Promise<number> {
    const response = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body,
    });

    return response.data.id;
  }

  /**
 * Create a review with summary and inline comments
 * Summary is posted as a separate issue comment (not review comment)
 * Inline comments are posted as review comments
 */
  async createReview(
    prNumber: number,
    commitId: string,
    summary: string,
    comments?: ReviewComment[]
  ): Promise<void> {
    // Post summary as a separate issue comment (PR comment, not review)
    const formattedSummary = `# 📋 PR Summary\n\n${summary}`;
    await this.postComment(prNumber, formattedSummary);
    core.info(`✅ Posted summary as PR comment`);

    // Post inline comments as a review (without body/summary)
    if (comments && comments.length > 0) {
      const reviewComments = comments.map(c => ({
        path: c.path,
        line: c.line,
        body: this.formatCommentBody(c.body, c.severity),
      }));

      try {
        await this.octokit.rest.pulls.createReview({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          commit_id: commitId,
          event: "COMMENT",
          comments: reviewComments,
          // No body here - summary is posted separately
        });
        core.info(`✅ Posted ${reviewComments.length} inline review comments`);
      } catch (error) {
        core.warning(`Batch review failed, falling back to individual comments: ${error}`);

        for (const comment of reviewComments) {
          try {
            await this.octokit.rest.pulls.createReviewComment({
              owner: this.owner,
              repo: this.repo,
              pull_number: prNumber,
              commit_id: commitId,
              path: comment.path,
              line: comment.line,
              body: comment.body,
            });
          } catch (commentError) {
            core.warning(`Failed to post comment on ${comment.path}:${comment.line}: ${commentError}`);
          }
        }
      }
    }
  }

  /**
   * Format comment body with severity indicator
   */
  private formatCommentBody(body: string, severity: string): string {
    const severityIcons: Record<string, string> = {
      low: "📝",
      medium: "⚠️",
      high: "🔴",
      critical: "🚨",
    };

    const icon = severityIcons[severity.toLowerCase()] || "💡";
    const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);

    return `${icon} **${severityLabel}**\n\n${body}`;
  }

  /**
   * List all bot comments on a PR
   */
  async listBotComments(prNumber: number): Promise<BotComment[]> {
    const botComments: BotComment[] = [];

    // Fetch issue comments (general PR comments)
    try {
      const issueComments = await this.octokit.rest.issues.listComments({
        owner: this.owner,
        repo: this.repo,
        issue_number: prNumber,
        per_page: 100,
      });

      for (const comment of issueComments.data) {
        if (comment.user?.login === "github-actions[bot]") {
          botComments.push({
            id: comment.id,
            body: comment.body || "",
            isSummary: this.isSummaryComment(comment.body || ""),
            isOutdated: false,  // Issue comments don't have outdated status
            isMinimized: false,
            type: 'issue',
            path: undefined,
            line: undefined,
            createdAt: comment.created_at,
          });
        }
      }
    } catch (error) {
      core.warning(`Failed to fetch issue comments: ${error}`);
    }

    // Fetch review comments (inline comments on code)
    try {
      const reviewComments = await this.octokit.rest.pulls.listReviewComments({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
      });

      for (const comment of reviewComments.data) {
        if (comment.user?.login === "github-actions[bot]") {
          // Check if comment is outdated (line no longer exists in current diff)
          const isOutdated = comment.position === null || comment.line === null;

          botComments.push({
            id: comment.id,
            body: comment.body || "",
            isSummary: false,
            isOutdated: isOutdated,
            isMinimized: false, // GitHub API doesn't directly expose this
            type: 'review',
            path: comment.path,
            line: comment.line ?? comment.original_line ?? undefined,
            createdAt: comment.created_at,
          });
        }
      }
    } catch (error) {
      core.warning(`Failed to fetch review comments: ${error}`);
    }

    return botComments;
  }

  /**
   * Check if a comment is a summary comment
   */
  private isSummaryComment(body: string): boolean {
    return body.includes("📋 PR Summary") ||
      body.includes("## Summary") ||
      body.includes("# Review") ||
      body.includes("**Summary**") ||
      body.startsWith("## ") ||
      body.includes("review completed");
  }

  /**
   * Delete previous summary comments
   */
  async deletePreviousSummaries(prNumber: number): Promise<number> {
    const botComments = await this.listBotComments(prNumber);
    const summaries = botComments.filter(c => c.isSummary);
    let deletedCount = 0;

    for (const summary of summaries) {
      try {
        if (summary.type === 'issue') {
          await this.deleteComment(summary.id);
        } else {
          await this.deleteReviewComment(summary.id);
        }
        deletedCount++;
      } catch (error) {
        core.warning(`Failed to delete summary comment ${summary.id}: ${error}`);
      }
    }

    return deletedCount;
  }

  /**
   * Delete an issue comment
   */
  async deleteComment(commentId: number): Promise<void> {
    await this.octokit.rest.issues.deleteComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
    });
  }

  /**
   * Delete a review comment
   */
  async deleteReviewComment(commentId: number): Promise<void> {
    await this.octokit.rest.pulls.deleteReviewComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
    });
  }

  /**
   * Minimize comments (collapse them)
   */
  async minimizeComments(
    commentIds: number[],
    prNumber: number,
    reason: "OUTDATED" | "OFF_TOPIC" | "RESOLVED" | "DUPLICATE" = "OUTDATED"
  ): Promise<number> {
    let minimizedCount = 0;

    for (const commentId of commentIds) {
      try {
        const nodeId = await this.getCommentNodeId(commentId, prNumber);

        if (nodeId) {
          await this.octokit.graphql(`
            mutation MinimizeComment($id: ID!, $classifier: ReportedContentClassifiers!) {
              minimizeComment(input: {subjectId: $id, classifier: $classifier}) {
                minimizedComment {
                  isMinimized
                }
              }
            }
          `, {
            id: nodeId,
            classifier: reason,
          });
          minimizedCount++;
        }
      } catch (error) {
        core.warning(`Failed to minimize comment ${commentId}: ${error}`);
      }
    }

    return minimizedCount;
  }

  /**
   * Get comment node ID for GraphQL operations
   */
  private async getCommentNodeId(commentId: number, prNumber: number): Promise<string | null> {
    try {
      const issueComment = await this.octokit.rest.issues.getComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: commentId,
      });
      return issueComment.data.node_id;
    } catch {
      try {
        const reviewComment = await this.octokit.rest.pulls.getReviewComment({
          owner: this.owner,
          repo: this.repo,
          comment_id: commentId,
        });
        return reviewComment.data.node_id;
      } catch {
        return null;
      }
    }
  }

  /**
   * Create a reply to a review comment
   */
  async createReply(prNumber: number, commentId: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.createReplyForReviewComment({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      comment_id: commentId,
      body,
    });
  }

  /**
   * Get comment thread for context
   */
  async getCommentThread(prNumber: number, commentId: number): Promise<ThreadComment[]> {
    const thread: ThreadComment[] = [];

    try {
      const comment = await this.octokit.rest.pulls.getReviewComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: commentId,
      });

      const allComments = await this.octokit.rest.pulls.listReviewComments({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
      });

      const targetPath = comment.data.path;
      const targetLine = comment.data.line || comment.data.original_line;
      const targetInReplyTo = comment.data.in_reply_to_id;

      let rootId = targetInReplyTo || commentId;

      const threadComments = allComments.data.filter(c => {
        return c.id === rootId ||
          c.in_reply_to_id === rootId ||
          (c.path === targetPath && (c.line === targetLine || c.original_line === targetLine));
      });

      threadComments.sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      for (const c of threadComments) {
        thread.push({
          author: c.user?.login || "unknown",
          body: c.body || "",
          isBot: c.user?.login === "github-actions[bot]",
        });
      }
    } catch (error) {
      core.warning(`Failed to get comment thread: ${error}`);
    }

    return thread;
  }

  /**
   * Update an existing comment
   */
  async updateComment(commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      body,
    });
  }

  /**
   * Update an existing review comment
   */
  async updateReviewComment(commentId: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.updateReviewComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      body,
    });
  }

  /**
   * Get PR details
   */
  async getPRDetails(prNumber: number): Promise<{
    title: string;
    body: string;
    author: string;
    baseBranch: string;
    headBranch: string;
  }> {
    const response = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    return {
      title: response.data.title,
      body: response.data.body || "",
      author: response.data.user?.login || "unknown",
      baseBranch: response.data.base.ref,
      headBranch: response.data.head.ref,
    };
  }

  /**
   * Add labels to PR
   */
  async addLabels(prNumber: number, labels: string[]): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      labels,
    });
  }

  /**
   * Add reaction to a comment
   */
  async addReaction(
    commentId: number,
    reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"
  ): Promise<void> {
    await this.octokit.rest.reactions.createForIssueComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      content: reaction,
    });
  }
}