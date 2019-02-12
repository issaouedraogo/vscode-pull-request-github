/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { parseDiff, getModifiedContentFromDiffHunk, DiffChangeType } from '../../common/diffHunk';
import { mapHeadLineToDiffHunkPosition, getZeroBased, getAbsolutePosition, getPositionInDiff } from '../../common/diffPositionMapping';
import { SlimFileChange, GitChangeType } from '../../common/file';
import Logger from '../../common/logger';
import { Resource } from '../../common/resources';
import { fromPRUri, toPRUri } from '../../common/uri';
import { groupBy, formatError } from '../../common/utils';
import { DescriptionNode } from './descriptionNode';
import { RemoteFileChangeNode, InMemFileChangeNode, GitFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';
import { getInMemPRContentProvider } from '../inMemPRContentProvider';
import { Comment } from '../../common/comment';
import { PullRequestManager, onDidSubmitReview } from '../../github/pullRequestManager';
import { PullRequestModel } from '../../github/pullRequestModel';

export function providePRDocumentComments(
	document: vscode.TextDocument,
	prNumber: number,
	fileChanges: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode)[],
	inDraftMode: boolean) {
	const params = fromPRUri(document.uri);

	if (!params || params.prNumber !== prNumber) {
		return;
	}

	const isBase = params.isBase;
	const fileChange = fileChanges.find(change => change.fileName === params.fileName);
	if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
		return;
	}

	let commentingRanges: vscode.Range[] = [];
	// Partial file change indicates that the file content is only the diff, so the entire
	// document can be commented on.
	if (fileChange.isPartial) {
		commentingRanges.push(new vscode.Range(0, 0, document.lineCount, 0));
	} else {
		const diffHunks = fileChange.diffHunks;

		for (let i = 0; i < diffHunks.length; i++) {
			const diffHunk = diffHunks[i];
			let startingLine: number;
			let length: number;
			if (isBase) {
				startingLine = getZeroBased(diffHunk.oldLineNumber);
				length = getZeroBased(diffHunk.oldLength);
			} else {
				startingLine = getZeroBased(diffHunk.newLineNumber);
				length = getZeroBased(diffHunk.newLength);
			}

			commentingRanges.push(new vscode.Range(startingLine, 0, startingLine + length, 0));
		}
	}

	const matchingComments = fileChange.comments;
	if (!matchingComments || !matchingComments.length) {
		return {
			threads: [],
			commentingRanges,
			inDraftMode
		};
	}

	let sections = groupBy(matchingComments, comment => String(comment.position));
	let threads: vscode.CommentThread[] = [];

	for (let i in sections) {
		let comments = sections[i];

		const firstComment = comments[0];
		let commentAbsolutePosition = fileChange.isPartial
			? getPositionInDiff(firstComment, fileChange.diffHunks, isBase)
			: getAbsolutePosition(firstComment, fileChange.diffHunks, isBase);

		if (commentAbsolutePosition < 0) {
			continue;
		}

		const pos = new vscode.Position(getZeroBased(commentAbsolutePosition), 0);
		const range = new vscode.Range(pos, pos);

		threads.push({
			threadId: firstComment.id.toString(),
			resource: document.uri,
			range,
			comments: comments.map(comment => {
				return {
					commentId: comment.id.toString(),
					body: new vscode.MarkdownString(comment.body),
					userName: comment.user!.login,
					gravatar: comment.user!.avatarUrl,
					canEdit: comment.canEdit,
					canDelete: comment.canDelete,
					isDraft: !!comment.isDraft,
					commentReactions: comment.reactions ? comment.reactions.map(reaction => {
						return { label: reaction.label, hasReacted: reaction.viewerHasReacted };
					}) : []
				};
			}),
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
		});
	}

	return {
		threads,
		commentingRanges,
		inDraftMode
	};
}

function commentsToCommentThreads(fileChange: InMemFileChangeNode, comments: Comment[], isBase: boolean): vscode.CommentThread[] {
	let sections = groupBy(comments, comment => comment.position!.toString());
	let threads: vscode.CommentThread[] = [];

	for (let i in sections) {
		let commentGroup = sections[i];

		const firstComment = commentGroup[0];
		let commentAbsolutePosition = fileChange.isPartial
			? getPositionInDiff(firstComment, fileChange.diffHunks, isBase)
			: getAbsolutePosition(firstComment, fileChange.diffHunks, isBase);

		if (commentAbsolutePosition < 0) {
			continue;
		}

		const pos = new vscode.Position(getZeroBased(commentAbsolutePosition), 0);
		const range = new vscode.Range(pos, pos);

		threads.push({
			threadId: firstComment.id.toString(),
			resource: isBase ? fileChange.parentFilePath : fileChange.filePath,
			range,
			comments: commentGroup.map(comment => {
				return {
					commentId: comment.id.toString(),
					body: new vscode.MarkdownString(comment.body),
					userName: comment.user!.login,
					gravatar: comment.user!.avatarUrl,
					canEdit: comment.canEdit,
					canDelete: comment.canDelete,
					isDraft: !!comment.isDraft
				};
			}),
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
		});
	}

	return threads;
}

function getRemovedCommentThreads(oldCommentThreads: vscode.CommentThread[], newCommentThreads: vscode.CommentThread[]) {
	let removed: vscode.CommentThread[] = [];
	oldCommentThreads.forEach(thread => {
		// No current threads match old thread, it has been removed
		const matchingThreads = newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
		if (matchingThreads.length === 0) {
			removed.push(thread);
		}
	});

	return removed;
}

function getAddedOrUpdatedCommentThreads(oldCommentThreads: vscode.CommentThread[], newCommentThreads: vscode.CommentThread[]) {
	let added: vscode.CommentThread[] = [];
	let changed: vscode.CommentThread[] = [];

	function commentsEditedInThread(oldComments: vscode.Comment[], newComments: vscode.Comment[]): boolean {
		return oldComments.some(oldComment => {
			const matchingComment = newComments.filter(newComment => newComment.commentId === oldComment.commentId);
			if (matchingComment.length !== 1) {
				return true;
			}

			if (matchingComment[0].body.value !== oldComment.body.value) {
				return true;
			}

			return false;
		});
	}

	newCommentThreads.forEach(thread => {
		const matchingCommentThread = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

		// No old threads match this thread, it is new
		if (matchingCommentThread.length === 0) {
			added.push(thread);
			if (thread.resource.scheme === 'file') {
				thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			}
		}

		// Check if comment has been updated
		matchingCommentThread.forEach(match => {
			if (match.comments.length !== thread.comments.length || commentsEditedInThread(matchingCommentThread[0].comments, thread.comments)) {
				changed.push(thread);
			}
		});
	});

	return [added, changed];
}

export class PRNode extends TreeNode {
	static ID = 'PRNode';
	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[];
	private _documentCommentsProvider: vscode.Disposable;
	private _onDidChangeCommentThreads: vscode.EventEmitter<vscode.CommentThreadChangedEvent>;
	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		private _prManager: PullRequestManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean
	) {
		super();
	}

	async getChildren(): Promise<TreeNode[]> {
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.prNumber}`, PRNode.ID);
		try {
			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
			}

			const comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
			const data = await this._prManager.getPullRequestFileChangesInfo(this.pullRequestModel);
			const mergeBase = this.pullRequestModel.mergeBase;
			if (!mergeBase) {
				return [];
			}

			const rawChanges = await parseDiff(data, this._prManager.repository, mergeBase);
			let fileChanges = rawChanges.map(change => {
				if (change instanceof SlimFileChange) {
					return new RemoteFileChangeNode(
						this,
						this.pullRequestModel,
						change.status,
						change.fileName,
						change.blobUrl
					);
				}

				const headCommit = this.pullRequestModel.head.sha;
				let changedItem = new InMemFileChangeNode(
					this,
					this.pullRequestModel,
					change.status,
					change.fileName,
					change.previousFileName,
					change.blobUrl,
					toPRUri(vscode.Uri.file(path.resolve(this._prManager.repository.rootUri.fsPath, change.fileName)), this.pullRequestModel, change.baseCommit, headCommit, change.fileName, false, change.status),
					toPRUri(vscode.Uri.file(path.resolve(this._prManager.repository.rootUri.fsPath, change.fileName)), this.pullRequestModel, change.baseCommit, headCommit, change.fileName, true, change.status),
					change.isPartial,
					change.patch,
					change.diffHunks,
					comments.filter(comment => comment.path === change.fileName && comment.position !== null),
				);

				return changedItem;
			});

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRContentProvider().registerTextDocumentContentProvider(this.pullRequestModel.prNumber, this.provideDocumentContent.bind(this));
			}

			// The review manager will register a document comment's provider, so the node does not need to
			if (!this.pullRequestModel.equals(this._prManager.activePullRequest)) {
				if (this._documentCommentsProvider) {
					// diff comments
					await this.updateComments(comments, fileChanges);
					this._fileChanges = fileChanges;
				} else {
					this._fileChanges = fileChanges;
					this._onDidChangeCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
					await this.pullRequestModel.githubRepository.ensureCommentsProvider();
					this._documentCommentsProvider = this.pullRequestModel.githubRepository.commentsProvider.registerDocumentCommentProvider(this.pullRequestModel, {
						onDidChangeCommentThreads: this._onDidChangeCommentThreads.event,
						provideDocumentComments: this.provideDocumentComments.bind(this),
						createNewCommentThread: this.createNewCommentThread.bind(this),
						replyToCommentThread: this.replyToCommentThread.bind(this),
						editComment: this.editComment.bind(this),
						deleteComment: this.deleteComment.bind(this),
						startDraft: this.startDraft.bind(this),
						finishDraft: this.finishDraft.bind(this),
						deleteDraft: this.deleteDraft.bind(this)
					});

					this._disposables.push(onDidSubmitReview(_ => {
						this.updateCommentPendingState();
					}));
				}
			} else {
				this._fileChanges = fileChanges;
			}

			let result = [new DescriptionNode(this, 'Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this.pullRequestModel), ...this._fileChanges];

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
			return [];
		}
	}

	async revealComment(comment: Comment) {
		let fileChange = this._fileChanges.find(fc => {
			if (fc.fileName !== comment.path) {
				return false;
			}

			if (fc.pullRequest.head.sha !== comment.commitId) {
				return false;
			}

			return true;
		});

		if (fileChange) {
			await this.reveal(fileChange, { focus: true });
			if (!fileChange.command.arguments) {
				return;
			}
			if (fileChange instanceof InMemFileChangeNode) {
				let lineNumber = fileChange.getCommentPosition(comment);
				const opts = fileChange.opts;
				opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				fileChange.opts = opts;
				await vscode.commands.executeCommand(fileChange.command.command, fileChange);
			} else {
				await vscode.commands.executeCommand(fileChange.command.command, ...fileChange.command.arguments!);
			}
		}
	}

	getTreeItem(): vscode.TreeItem {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._prManager.activePullRequest);

		const {
			title,
			prNumber,
			author,
		} = this.pullRequestModel;

		const {
			login,
		} = author;

		const labelPrefix = (currentBranchIsForThisPR ? '✓ ' : '');
		const tooltipPrefix = (currentBranchIsForThisPR ? 'Current Branch * ' : '');
		const formattedPRNumber = prNumber.toString();
		const label = `${labelPrefix}${title}`;
		const tooltip = `${tooltipPrefix}${title} (#${formattedPRNumber}) by @${login}`;
		const description = `#${formattedPRNumber} by @${login}`;

		return {
			label,
			tooltip,
			description,
			collapsibleState: 1,
			contextValue: 'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.userAvatarUri
		};
	}

	private async updateComments(comments: Comment[], fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[]): Promise<void> {
		if (!this._onDidChangeCommentThreads) {
			return;
		}

		let added: vscode.CommentThread[] = [];
		let removed: vscode.CommentThread[] = [];
		let changed: vscode.CommentThread[] = [];

		for (let i = 0; i < this._fileChanges.length; i++) {
			let oldFileChange = this._fileChanges[i];
			if (oldFileChange instanceof RemoteFileChangeNode) {
				continue;
			}
			let newFileChange: InMemFileChangeNode;
			let newFileChanges = fileChanges.filter(fileChange => fileChange instanceof InMemFileChangeNode).filter(fileChange => fileChange.fileName === oldFileChange.fileName);
			if (newFileChanges && newFileChanges.length) {
				newFileChange = newFileChanges[0] as InMemFileChangeNode;
			} else {
				continue;
			}

			let oldLeftSideCommentThreads = commentsToCommentThreads(oldFileChange, oldFileChange.comments, true);
			let newLeftSideCommentThreads = commentsToCommentThreads(newFileChange, newFileChange.comments, true);

			removed.push(...getRemovedCommentThreads(oldLeftSideCommentThreads, newLeftSideCommentThreads));
			let leftSideAddedOrUpdated = getAddedOrUpdatedCommentThreads(oldLeftSideCommentThreads, newLeftSideCommentThreads);
			added.push(...leftSideAddedOrUpdated[0]);
			changed.push(...leftSideAddedOrUpdated[1]);

			let oldRightSideCommentThreads = commentsToCommentThreads(oldFileChange, oldFileChange.comments, false);
			let newRightSideCommentThreads = commentsToCommentThreads(newFileChange, newFileChange.comments, false);

			removed.push(...getRemovedCommentThreads(oldRightSideCommentThreads, newRightSideCommentThreads));
			let rightSideAddedOrUpdated = getAddedOrUpdatedCommentThreads(oldRightSideCommentThreads, newRightSideCommentThreads);
			added.push(...rightSideAddedOrUpdated[0]);
			changed.push(...rightSideAddedOrUpdated[1]);
		}

		if (added.length || removed.length || changed.length) {
			this._onDidChangeCommentThreads.fire({
				added: added,
				removed: removed,
				changed: changed,
				inDraftMode: await this._prManager.inDraftMode(this.pullRequestModel)
			});
			// this._onDidChangeDecorations.fire();
		}

		return;
	}

	private async provideDocumentContent(uri: vscode.Uri): Promise<string> {
		let params = fromPRUri(uri);
		if (!params) {
			return '';
		}

		let fileChanges = this._fileChanges.filter(contentChange => (contentChange instanceof InMemFileChangeNode) && contentChange.fileName === params!.fileName);
		if (fileChanges.length) {
			let fileChange = fileChanges[0] as InMemFileChangeNode;
			let readContentFromDiffHunk = fileChange.isPartial || fileChange.status === GitChangeType.ADD || fileChange.status === GitChangeType.DELETE;

			if (readContentFromDiffHunk) {
				if (params.isBase) {
					// left
					let left = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							let diffLine = fileChange.diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Delete) {
								left.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								left.push(diffLine.text);
							}
						}
					}

					return left.join('\n');
				} else {
					let right = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							let diffLine = fileChange.diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								right.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Delete) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								right.push(diffLine.text);
							}
						}
					}

					return right.join('\n');
				}
			} else {
				const originalFileName = fileChange.status === GitChangeType.RENAME ? fileChange.previousFileName : fileChange.fileName;
				const originalFilePath = path.join(this._prManager.repository.rootUri.fsPath, originalFileName!);
				const originalContent = await this._prManager.repository.show(params.baseCommit, originalFilePath);

				if (params.isBase) {
					return originalContent;
				} else {
					return getModifiedContentFromDiffHunk(originalContent, fileChange.patch);
				}
			}
		}
		Logger.appendLine(`PR> can not find content for document ${uri.toString()}`);
		return '';
	}

	private findMatchingFileNode(uri: vscode.Uri): InMemFileChangeNode {
		const params = fromPRUri(uri);

		if (!params) {
			throw new Error(`${uri.toString()} is not valid PR document`);
		}

		const fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

		if (!fileChange) {
			throw new Error('No matching file found');
		}

		if (fileChange instanceof RemoteFileChangeNode) {
			throw new Error('Comments not supported on remote file changes');
		}

		return fileChange;
	}

	private async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string) {
		try {
			let uri = document.uri;
			let params = fromPRUri(uri);

			if (params && params.prNumber !== this.pullRequestModel.prNumber) {
				return null;
			}

			const fileChange = this.findMatchingFileNode(uri);

			let isBase = !!(params && params.isBase);
			let position = mapHeadLineToDiffHunkPosition(fileChange.diffHunks, '', range.start.line + 1, isBase);

			if (position < 0) {
				throw new Error('Comment position cannot be negative');
			}

			// there is no thread Id, which means it's a new thread
			let rawComment = await this._prManager.createComment(this.pullRequestModel, text, params!.fileName, position);
			let comment: vscode.Comment = {
				commentId: rawComment!.id.toString(),
				body: new vscode.MarkdownString(rawComment!.body),
				userName: rawComment!.user!.login,
				gravatar: rawComment!.user!.avatarUrl,
				canEdit: rawComment!.canEdit,
				canDelete: rawComment!.canDelete,
				isDraft: !!rawComment!.isDraft
			};

			fileChange.comments.push(rawComment!);

			let commentThread: vscode.CommentThread = {
				threadId: comment.commentId,
				resource: uri,
				range: range,
				comments: [comment]
			};

			return commentThread;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async editComment(document: vscode.TextDocument, comment: vscode.Comment, text: string): Promise<void> {
		const fileChange = this.findMatchingFileNode(document.uri);
		const existingComment = fileChange.comments.find(c => c.id.toString() === comment.commentId);
		if (!existingComment) {
			throw new Error('Unable to find comment');
		}

		const rawComment = await this._prManager.editReviewComment(this.pullRequestModel, existingComment, text);

		const index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
		if (index > -1) {
			fileChange.comments.splice(index, 1, rawComment);
		}
	}

	private async deleteComment(document: vscode.TextDocument, comment: vscode.Comment): Promise<void> {
		const fileChange = this.findMatchingFileNode(document.uri);

		await this._prManager.deleteReviewComment(this.pullRequestModel, comment.commentId);
		const index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
		if (index > -1) {
			fileChange.comments.splice(index, 1);
		}

		const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
		if (this._onDidChangeCommentThreads) {
			this._onDidChangeCommentThreads.fire({
				added: [],
				changed: [],
				removed: [],
				inDraftMode
			});
		}
	}

	private async replyToCommentThread(document: vscode.TextDocument, _range: vscode.Range, thread: vscode.CommentThread, text: string) {
		try {
			const fileChange = this.findMatchingFileNode(document.uri);

			const commentFromThread = fileChange.comments.find(c => c.id.toString() === thread.threadId);
			if (!commentFromThread) {
				throw new Error('Unable to find thread to respond to.');
			}

			const rawComment = await this._prManager.createCommentReply(this.pullRequestModel, text, commentFromThread);
			thread.comments.push({
				commentId: rawComment!.id.toString(),
				body: new vscode.MarkdownString(rawComment!.body),
				userName: rawComment!.user!.login,
				gravatar: rawComment!.user!.avatarUrl,
				canEdit: rawComment!.canEdit,
				canDelete: rawComment!.canDelete,
				isDraft: !!rawComment!.isDraft
			});

			fileChange.comments.push(rawComment!);

			return thread;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async provideDocumentComments(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.CommentInfo | undefined> {
		if (document.uri.scheme === 'pr') {
			const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
			return providePRDocumentComments(document, this.pullRequestModel.prNumber, this._fileChanges, inDraftMode);
		}

		return;
	}

	private async startDraft(_token: vscode.CancellationToken): Promise<void> {
		await this._prManager.startReview(this.pullRequestModel);
		this._onDidChangeCommentThreads.fire({
			added: [],
			changed: [],
			removed: [],
			inDraftMode: true
		});
	}

	private updateCommentPendingState() {
		this._fileChanges.forEach(fileChange => {
			if (fileChange instanceof InMemFileChangeNode) {
				fileChange.comments.forEach(c => c.isDraft = false);
			}
		});

		const commentThreads = this._fileChanges
			.reduce((threads, change) => change instanceof InMemFileChangeNode
				? threads
					.concat(commentsToCommentThreads(change, change.comments, false))
					.concat(commentsToCommentThreads(change, change.comments, true))
				: threads,
				[] as vscode.CommentThread[]);

		this._onDidChangeCommentThreads.fire({
			added: [],
			changed: commentThreads,
			removed: [],
			inDraftMode: false
		});
	}

	private calculateChangedAndRemovedThreads(changed: vscode.CommentThread[], removed: vscode.CommentThread[], fileChange: InMemFileChangeNode, deletedComments: Comment[], isBase: boolean): void {
		const oldCommentThreads = commentsToCommentThreads(fileChange, fileChange.comments, isBase);
		oldCommentThreads.forEach(thread => {
			thread.comments = thread.comments.filter(comment => !deletedComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
			if (!thread.comments.length) {
				removed.push(thread);
			} else {
				changed.push(thread);
			}
		});
	}

	private async deleteDraft(_token: vscode.CancellationToken): Promise<void> {
		const { deletedReviewId, deletedReviewComments } = await this._prManager.deleteReview(this.pullRequestModel);

		let changed: vscode.CommentThread[] = [];
		let removed: vscode.CommentThread[] = [];

		// Group comments by file and then position to create threads.
		const commentsByPath = groupBy(deletedReviewComments, comment => comment.path || '');

		for (let filePath in commentsByPath) {
			const commentsForFile = commentsByPath[filePath];
			const matchingFileChange = this._fileChanges.find(fileChange => fileChange.fileName === filePath);

			if (matchingFileChange && matchingFileChange instanceof InMemFileChangeNode) {
				this.calculateChangedAndRemovedThreads(changed, removed, matchingFileChange, commentsForFile, true);
				this.calculateChangedAndRemovedThreads(changed, removed, matchingFileChange, commentsForFile, false);

				// Remove deleted comments from the file change's comment list
				matchingFileChange.comments = matchingFileChange.comments.filter(comment => comment.pullRequestReviewId !== deletedReviewId);
			}
		}

		this._onDidChangeCommentThreads.fire({
			added: [],
			changed,
			removed,
			inDraftMode: false
		});
	}

	private async finishDraft(_token: vscode.CancellationToken): Promise<void> {
		try {
			await this._prManager.submitReview(this.pullRequestModel);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	dispose(): void {
		super.dispose();

		if (this._documentCommentsProvider) {
			this._documentCommentsProvider.dispose();
		}

		if (this._inMemPRContentProvider) {
			this._inMemPRContentProvider.dispose();
		}

		this._disposables.forEach(d => d.dispose());
	}
}
