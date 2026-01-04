import * as core from "@actions/core";
import * as github from "@actions/github";
import { getConfig } from "./config";
import { GitHubService } from "./services/github";
import { AIService } from "./services/ai";
import { isFileIgnored, parseReviewComment } from "./utils";

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
      await githubService.createReview(
        prNumber,
        validComments.map((c) => ({
          path: c.file,
          line: c.line,
          body: c.body,
        })),
      );
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
