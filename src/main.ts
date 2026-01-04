import * as core from "@actions/core";
import * as github from "@actions/github";
import { getConfig } from "./config";
import { GitHubService } from "./services/github";
import { AIService } from "./services/ai";
import {
  isFileIgnored,
  parseReviewComment,
  getSeverityLevel,
  SeverityLevel,
} from "./utils";

async function run(): Promise<void> {
  try {
    const config = getConfig();
    const githubService = new GitHubService(config.githubToken);
    const aiService = new AIService(config);

    const { eventName, payload } = github.context;
    let prNumber: number;
    let customInstructions: string | undefined;

    // 1. Event Handling
    if (eventName === "pull_request") {
      if (payload.action !== "opened" && payload.action !== "synchronize") {
        core.info(`Skipping action: ${payload.action}`);
        return;
      }
      prNumber = payload.pull_request!.number;
    } else if (eventName === "pull_request_review_comment") {
      // Handle user replies to AI comments
      if (payload.action !== "created") return;

      const comment = payload.comment;
      const pr = payload.pull_request;
      prNumber = pr!.number;

      // Check if the reply is to a comment made by this bot or if it's just a general reply
      // Ideally we would check if the parent comment is from the bot.
      // But for now, we'll respond if the user explicitly asks the bot or if it's in a thread the bot started.

      // Important: Avoid infinite loops. Don't reply to our own comments.
      const currentUser = await githubService.getAuthenticatedUser();
      if (comment!.user.login === currentUser.login) {
        return;
      }

      // We need to fetch the thread context
      const diff = await githubService.getPullRequestDiff(prNumber);

      // Fetch the full comment thread
      core.info("Fetching comment thread for context...");
      const threadComments = await githubService.getCommentThread(prNumber, comment!.id);

      // Construct the comment chain with full thread context
      let commentChain = "";
      if (threadComments.length > 0) {
        // Build a structured conversation history
        commentChain = "Conversation History:\n";
        threadComments.forEach((threadComment, index) => {
          const authorPrefix = threadComment.isBot ? "AI Reviewer" : threadComment.author;
          commentChain += `${index + 1}. ${authorPrefix}: ${threadComment.body}\n`;
        });
        core.info(`Thread context built with ${threadComments.length} comments`);
      } else {
        // Fallback to single comment if thread fetching failed
        commentChain = `User: ${comment!.body}`;
        core.info("Using fallback single comment context");
      }

      core.info("Generating reply to user comment...");
      const reply = await aiService.generateReply(diff, commentChain);

      await githubService.createReply(prNumber, comment!.id, reply);
      return;
    } else if (eventName === "issue_comment") {
      if (payload.action !== "created") return;

      const commentBody = payload.comment!.body;
      const { isReview, instructions } = parseReviewComment(commentBody);

      if (!isReview) {
        core.info("Comment is not a /review command. Skipping.");
        return;
      }

      // Ensure it's a PR comment, not just an Issue comment
      if (!payload.issue!.pull_request) {
        core.info("Comment is on an Issue, not a PR. Skipping.");
        return;
      }

      prNumber = payload.issue!.number;
      customInstructions = instructions;

      // Post a reaction to acknowledge the command
      await githubService.postComment(prNumber, "👀 AI Review started...");
    } else {
      core.info(`Unsupported event: ${eventName}`);
      return;
    }

    // 2. Fetch Changed Files & Filter Ignored
    const changedFiles = await githubService.getChangedFiles(prNumber);
    const filesToReview = changedFiles.filter(
      (file) => !isFileIgnored(file, config.ignorePatterns),
    );

    if (filesToReview.length === 0) {
      core.info("No files to review after filtering.");
      return;
    }

    // 3. Fetch Diff
    const diff = await githubService.getPullRequestDiff(prNumber);

    // TODO: Improve diff handling for very large PRs (truncation or chunking)
    // For now, we pass the raw diff.

    // 4. Get AI Review
    core.info("Requesting review from AI...");
    const review = await aiService.getReview(diff, customInstructions);

    // Cleanup previous reviews
    core.info("Removing outdated comments...");
    try {
      const currentUser = await githubService.getAuthenticatedUser();

      // Delete Issue Comments (General comments)
      const comments = await githubService.listComments(prNumber);
      for (const comment of comments) {
        if (
          comment.user?.login === currentUser.login &&
          !comment.body?.includes("👀 AI Review started")
        ) {
          await githubService.deleteComment(comment.id);
        }
      }

      // Delete Review Comments (Inline comments)
      const reviewComments = await githubService.listReviewComments(prNumber);
      for (const comment of reviewComments) {
        if (comment.user?.login === currentUser.login) {
          await githubService.deleteReviewComment(comment.id);
        }
      }
    } catch (error) {
      core.warning(
        `Failed to remove outdated comments: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }

    // 5. Post Summary
    if (review.summary) {
      await githubService.postComment(
        prNumber,
        `## AI Review Summary\n\n${review.summary}`,
      );
    }

    // 6. Post Inline Comments
    if (review.comments && review.comments.length > 0) {
      const validComments = review.comments.filter((c) =>
        filesToReview.includes(c.file),
      );

      // Filter comments based on severity
      const minSeverityLevel = getSeverityLevel(config.minSeverity);
      const filteredComments = validComments.filter(
        (c) => getSeverityLevel(c.severity) >= minSeverityLevel,
      );

      // Log filtering results
      const filteredCount = validComments.length - filteredComments.length;
      if (filteredCount > 0) {
        core.info(
          `Filtered ${filteredCount} comments below ${config.minSeverity} severity level`,
        );
        core.info(
          `Posting ${filteredComments.length} comments meeting ${config.minSeverity} severity or higher`,
        );
      } else {
        core.info(
          `All ${validComments.length} comments meet ${config.minSeverity} severity level or higher`,
        );
      }

      // Log severity distribution for debugging
      const severityCounts: Record<SeverityLevel, number> = {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      };
      validComments.forEach((c) => {
        severityCounts[c.severity]++;
      });
      core.debug(`Severity distribution: ${JSON.stringify(severityCounts)}`);

      if (filteredComments.length > 0) {
        await githubService.createReview(
          prNumber,
          filteredComments.map((c) => ({
            path: c.file,
            line: c.line,
            body: c.body,
          })),
        );
      }
    }

    core.info("Review completed successfully.");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unknown error occurred");
    }
  }
}

run();
