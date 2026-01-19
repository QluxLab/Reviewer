import * as github from "@actions/github";
import * as core from "@actions/core";
import { GitHub } from "@actions/github/lib/utils";
import { SeverityLevel } from "./ai";

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

  /**
   * Map severity to GitHub Alert type
   */
  private getAlertType(severity: SeverityLevel): string {
    const alertMap: Record<SeverityLevel, string> = {
      critical: "CAUTION",
      high: "WARNING",
      medium: "IMPORTANT",
      low: "TIP",
    };
    return alertMap[severity] || "NOTE";
  }

  /**
   * Format inline comment body with GitHub Alert syntax
   */
  private formatInlineComment(body: string, severity: SeverityLevel): string {
    // If the body already starts with an alert, return as-is
    if (body.trim().startsWith("> [!")) {
      return body;
    }

    // Otherwise, wrap it in the appropriate alert based on severity
    const alertType = this.getAlertType(severity);

    // Split body into lines and format each line with quote syntax
    const lines = body.split("\n");
    const formattedLines = lines.map(line => `> ${line}`);

    return `> [!${alertType}]\n${formattedLines.join("\n")}`;
  }

  /**
   * Format summary with GitHub Alert NOTE syntax
   */
  private formatSummary(summary: string): string {
    // If the summary already starts with an alert, return as-is
    if (summary.trim().startsWith("> [!")) {
      return summary;
    }

    // Clean format with markdown header and NOTE alert
    const lines = summary.split("\n");
    const formattedLines = lines.map(line => `> ${line}`);

    return `# 📋 PR Summary\n\n> [!NOTE]\n${formattedLines.join("\n")}`;
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

  /**
   * Create a review with summary and optional inline comments
   */
  async createReview(
    prNumber: number,
    commitId: string,
    summary: string,
    comments?: Array<{ path: string; line: number; body: string; severity: SeverityLevel }>,
  ): Promise<void> {
    const formattedComments = comments?.map((c) => ({
      path: c.path,
      line: c.line,
      body: this.formatInlineComment(c.body, c.severity),
    }));

    // Post summary as a separate issue comment (so it can be deleted easily)
    const formattedSummary = this.formatSummary(summary);
    await this.postComment(prNumber, formattedSummary);

    // Post inline comments as a review (without body)
    if (formattedComments && formattedComments.length > 0) {
      await this.octokit.rest.pulls.createReview({
        ...this.repo,
        pull_number: prNumber,
        commit_id: commitId,
        event: "COMMENT",
        comments: formattedComments,
      });
    }

    core.info(
      `Review posted with summary and ${formattedComments?.length || 0} inline comments`
    );
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
    try {
      await this.octokit.rest.issues.deleteComment({
        ...this.repo,
        comment_id: commentId,
      });
      core.info(`Deleted issue comment ${commentId}`);
    } catch (error) {
      core.warning(`Failed to delete issue comment ${commentId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async listReviewComments(prNumber: number) {
    const { data: comments } = await this.octokit.rest.pulls.listReviewComments({
      ...this.repo,
      pull_number: prNumber,
    });
    return comments;
  }

  async listBotComments(prNumber: number): Promise<
    Array<{
      id: number;
      body: string;
      path?: string;
      line?: number;
      type: "issue" | "review";
      isOutdated: boolean;
      isSummary?: boolean;
      isMinimized?: boolean;
    }>
  > {
    const botUser = await this.getAuthenticatedUser();
    const result: Array<{
      id: number;
      body: string;
      path?: string;
      line?: number;
      type: "issue" | "review";
      isOutdated: boolean;
      isSummary?: boolean;
      isMinimized?: boolean;
    }> = [];

    // 1. Issue Comments (General)
    // Issue comments are generally "active" unless manually minimized, but we treat them as active here.
    const issueComments = await this.listComments(prNumber);
    for (const comment of issueComments) {
      if (comment.user?.login === botUser.login) {
        // Check if this is a summary comment (contains "# 📋 PR Summary" or old format)
        const isSummary =
          comment.body?.includes("# 📋 PR Summary") ||
          (comment.body?.includes("> [!NOTE]") && comment.body?.includes("**AI Review Summary**"));

        result.push({
          id: comment.id,
          body: comment.body || "",
          type: "issue",
          isOutdated: false,
          isSummary,
          isMinimized: false, // Issue comments don't get minimized via API
        });
      }
    }

    // 2. Review Comments (Inline)
    const reviewComments = await this.listReviewComments(prNumber);
    for (const comment of reviewComments) {
      if (comment.user?.login === botUser.login) {
        // A review comment is outdated if it has no position in the current diff
        const isOutdated = comment.position === null;
        result.push({
          id: comment.id,
          body: comment.body,
          path: comment.path,
          line: comment.line || comment.original_line || undefined,
          type: "review",
          isOutdated,
          isSummary: false,
          // @ts-ignore - GitHub API may include this field
          isMinimized: comment.isMinimized || false,
        });
      }
    }

    core.info(`Found ${result.length} bot comments (${result.filter(c => !c.isOutdated).length} active, ${result.filter(c => c.isOutdated).length} outdated, ${result.filter(c => c.isSummary).length} summaries)`);

    return result;
  }

  async deleteReviewComment(commentId: number) {
    try {
      await this.octokit.rest.pulls.deleteReviewComment({
        ...this.repo,
        comment_id: commentId,
      });
      core.info(`Deleted review comment ${commentId}`);
    } catch (error) {
      core.warning(`Failed to delete review comment ${commentId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Minimize (hide) a comment instead of deleting it
   */
  async minimizeComment(commentId: number, nodeId?: string, classifier: string = "OUTDATED"): Promise<boolean> {
    try {
      // If nodeId is not provided, we need to fetch it
      if (!nodeId) {
        // Try to get it from review comment first
        try {
          const { data: comment } = await this.octokit.rest.pulls.getReviewComment({
            ...this.repo,
            comment_id: commentId,
          });
          // @ts-ignore - node_id exists but not in types
          nodeId = comment.node_id;
        } catch {
          // If not a review comment, try issue comment
          const { data: comment } = await this.octokit.rest.issues.getComment({
            ...this.repo,
            comment_id: commentId,
          });
          nodeId = comment.node_id;
        }
      }

      if (!nodeId) {
        core.warning(`Could not find node_id for comment ${commentId}`);
        return false;
      }

      // Use GraphQL to minimize the comment
      const mutation = `
        mutation MinimizeComment($subjectId: ID!, $classifier: ReportedContentClassifiers!) {
          minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) {
            minimizedComment {
              isMinimized
              minimizedReason
            }
          }
        }
      `;

      await this.octokit.graphql(mutation, {
        subjectId: nodeId,
        classifier: classifier,
      });

      core.info(`✓ Minimized comment ${commentId} (reason: ${classifier})`);
      return true;
    } catch (error) {
      core.warning(`Failed to minimize comment ${commentId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  /**
   * Delete multiple comments (both issue and review comments)
   */
  async deleteComments(commentIds: number[], prNumber: number): Promise<void> {
    if (commentIds.length === 0) {
      return;
    }

    core.info(`Deleting ${commentIds.length} comments...`);

    const allComments = await this.listBotComments(prNumber);

    for (const commentId of commentIds) {
      const comment = allComments.find(c => c.id === commentId);
      if (!comment) {
        core.warning(`Comment ${commentId} not found, skipping deletion`);
        continue;
      }

      if (comment.type === "issue") {
        await this.deleteComment(commentId);
      } else {
        await this.deleteReviewComment(commentId);
      }
    }
  }

  /**
   * Minimize (hide) multiple comments
   */
  async minimizeComments(
    commentIds: number[],
    prNumber: number,
    classifier: "OUTDATED" | "RESOLVED" | "DUPLICATE" | "SPAM" | "ABUSE" | "OFF_TOPIC" = "OUTDATED"
  ): Promise<number> {
    if (commentIds.length === 0) {
      return 0;
    }

    core.info(`🔽 Minimizing ${commentIds.length} comment(s) as ${classifier}...`);

    const allComments = await this.listBotComments(prNumber);
    let successCount = 0;

    for (const commentId of commentIds) {
      const comment = allComments.find(c => c.id === commentId);
      if (!comment) {
        core.warning(`Comment ${commentId} not found, skipping`);
        continue;
      }

      // Only minimize review comments (inline comments)
      // Issue comments cannot be minimized via API in the same way
      if (comment.type === "review") {
        const success = await this.minimizeComment(commentId, undefined, classifier);
        if (success) successCount++;
      } else {
        core.info(`Skipping issue comment ${commentId} (cannot minimize issue comments)`);
      }
    }

    core.info(`✓ Successfully minimized ${successCount}/${commentIds.length} comments`);
    return successCount;
  }

  /**
   * Delete all previous summary comments
   */
  async deletePreviousSummaries(prNumber: number): Promise<number> {
    const allComments = await this.listBotComments(prNumber);
    const summaries = allComments.filter(c => c.isSummary);

    if (summaries.length === 0) {
      return 0;
    }

    core.info(`🗑️  Deleting ${summaries.length} previous summary comment(s)...`);

    for (const summary of summaries) {
      await this.deleteComment(summary.id);
    }

    return summaries.length;
  }

  async createReply(prNumber: number, commentId: number, body: string) {
    await this.octokit.rest.pulls.createReplyForReviewComment({
      ...this.repo,
      pull_number: prNumber,
      comment_id: commentId,
      body,
    });
  }

  async getCommentThread(prNumber: number, commentId: number): Promise<Array<{ author: string; body: string; isBot: boolean }>> {
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

      // Find comments in the same thread
      // GitHub uses in_reply_to_id to link replies
      const threadComments: typeof allComments = [];

      // Find the root comment (the one without in_reply_to_id or the original comment)
      let rootComment = comment;
      if (comment.in_reply_to_id) {
        const root = allComments.find(c => c.id === comment.in_reply_to_id);
        if (root) rootComment = root;
      }

      // Add root comment
      threadComments.push(rootComment);

      // Find all replies to this root comment
      const replies = allComments.filter(c =>
        c.in_reply_to_id === rootComment.id
      );

      threadComments.push(...replies);

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

  /**
   * Get commit SHA for the PR head
   */
  async getPRHeadSHA(prNumber: number): Promise<string> {
    const pr = await this.getPRDetails(prNumber);
    return pr.head.sha;
  }
}