/**
 * The GitHub Releases content source.
 *
 * GitHub has no browsable content catalogue, so this source is the other kind:
 * the user adds repositories by hand, and this turns each one into a project
 * whose versions are its releases and whose download is one asset of a release.
 *
 * Where the launcher's own UI plugin store reads a repo's latest tag off the
 * `releases/latest` redirect — cheap, and it never spends the API rate limit —
 * this source needs the release *assets*, which only the REST API exposes. So it
 * uses the API, and offers a token setting for anyone who hits the
 * unauthenticated limit of 60 requests an hour.
 */

import type {
	ContentCard,
	ContentPage,
	ContentProject,
	ContentQuery,
	ContentSourceApi,
	ContentVersion,
	DownloadDescriptor,
	UpdateQueryItem,
	UpdateResult,
} from '@celestial/content-source'

import {
	type AssetMode,
	type MatchEntry,
	downloadableAssets,
	pickAsset,
	type ReleaseAsset,
} from './matching'

/** The key the launcher keeps manually-added entries under. */
const MANUAL_ENTRIES_KEY = 'manualEntries'

interface GitHubRepo {
	full_name: string
	description: string | null
	html_url: string
	created_at: string
	pushed_at: string | null
	updated_at: string | null
	stargazers_count: number
	license: { spdx_id: string | null; name: string } | null
	topics?: string[]
	archived: boolean
	owner: { login: string; avatar_url: string }
}

interface GitHubRelease {
	tag_name: string
	name: string | null
	body: string | null
	html_url: string
	draft: boolean
	prerelease: boolean
	published_at: string | null
	assets: ReleaseAsset[]
}

export async function activate(api: ContentSourceApi) {
	/** The repositories the user added, as stored by the launcher's form. */
	async function entries(): Promise<MatchEntry[]> {
		const raw = await api.storage.get(MANUAL_ENTRIES_KEY)
		if (!raw) return []
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			api.log('条目数据不是合法 JSON，忽略')
			return []
		}
		if (!Array.isArray(parsed)) return []
		const seen = new Set<string>()
		const result: MatchEntry[] = []
		for (const item of parsed) {
			if (!item || typeof item !== 'object') continue
			const record = item as Record<string, unknown>
			const repo = typeof record.repo === 'string' ? record.repo.trim() : ''
			if (!repo || seen.has(repo.toLowerCase())) continue
			seen.add(repo.toLowerCase())
			const type = typeof record.type === 'string' ? record.type.trim() : ''
			result.push({
				repo,
				name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined,
				type: type || undefined,
				rule: typeof record.rule === 'string' && record.rule.trim() ? record.rule.trim() : undefined,
				prefer:
					typeof record.prefer === 'string' && record.prefer.trim() ? record.prefer.trim() : undefined,
				exclude:
					typeof record.exclude === 'string' && record.exclude.trim()
						? record.exclude.trim()
						: undefined,
			})
		}
		return result
	}

	async function entryFor(repo: string): Promise<MatchEntry | undefined> {
		const all = await entries()
		return all.find((entry) => entry.repo.toLowerCase() === repo.toLowerCase())
	}

	/** The token, when the user set one, raises the rate limit and reaches private repos. */
	async function token(): Promise<string | undefined> {
		const value = await api.settings.get('token')
		return value && value.trim() ? value.trim() : undefined
	}

	async function assetMode(): Promise<AssetMode> {
		const value = await api.settings.get('assetMode')
		return value === 'first' || value === 'largest' ? value : 'jar'
	}

	/** Headers for a REST call, carrying the user's token when they set one. */
	async function apiHeaders(accept: string): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			accept,
			'x-github-api-version': '2022-11-28',
		}
		const value = await token()
		if (value) headers.authorization = `Bearer ${value}`
		return headers
	}

	/**
	 * One REST call. Errors carry GitHub's own message where there is one, because
	 * "rate limit exceeded" and "not found" need very different fixes.
	 */
	async function request(path: string, accept = 'application/vnd.github+json') {
		const response = await api.net.fetch(`https://api.github.com${path}`, {
			headers: await apiHeaders(accept),
		})
		if (!response.ok) {
			let detail = ''
			try {
				const body = JSON.parse(response.body) as { message?: string }
				detail = body.message ? `：${body.message}` : ''
			} catch {
				// A non-JSON error body tells us nothing extra.
			}
			throw new Error(`GitHub ${response.status} ${path}${detail}`)
		}
		return response
	}

	async function rest<T>(path: string): Promise<T> {
		const response = await request(path)
		return JSON.parse(response.body) as T
	}

	/**
	 * The repository's README, as Markdown, with its own relative links made
	 * absolute.
	 *
	 * A README refers to `./docs/screenshot.png` and `docs/logo.svg` freely; on
	 * github.com the page resolves those, but a rendered copy here has no
	 * repository to resolve against, so every image would come up broken. Only
	 * relative references are touched — a link that is already absolute is the
	 * author's intent and is left exactly as written.
	 *
	 * A repository with no README is not an error: the project simply has no
	 * description to show.
	 */
	async function readme(repo: string): Promise<string | undefined> {
		let body: string
		try {
			body = (await request(`/repos/${repo}/readme`, 'application/vnd.github.raw')).body
		} catch (error) {
			api.log(`读取 ${repo} 的 README 失败：${String(error)}`)
			return undefined
		}
		return absolutize(body, repo)
	}

	function absolutize(markdown: string, repo: string): string {
		const raw = (path: string) =>
			`https://raw.githubusercontent.com/${repo}/HEAD/${path
				.replace(/^\.?\//, '')
				.replace(/^\//, '')}`

		const isRelative = (url: string) => !/^([a-z][a-z0-9+.-]*:|#)/i.test(url)

		return markdown
			.replace(
				/(!?\[[^\]]*\]\()\s*([^)\s]+)([^)]*\))/g,
				(match, open: string, url: string, rest: string) =>
					isRelative(url) ? `${open}${raw(url)}${rest}` : match,
			)
			.replace(
				/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi,
				(match, open: string, url: string, close: string) =>
					isRelative(url) ? `${open}${raw(url)}${close}` : match,
			)
	}

	function toCard(repo: GitHubRepo, contentType: string, id?: string, name?: string): ContentCard {
		return {
			sourceId: api.source.id,
			id: id ?? repo.full_name,
			contentType: contentType as ContentCard['contentType'],
			// The entry's own name, when the user gave one, is what they recognise
			// the project by; the repo name is the fallback.
			name: name ?? repo.full_name,
			summary: repo.description ?? undefined,
			iconUrl: repo.owner?.avatar_url,
			author: repo.owner?.login,
			follows: repo.stargazers_count,
			publishedAt: repo.created_at,
			updatedAt: repo.pushed_at ?? repo.updated_at ?? undefined,
			tags: repo.archived ? ['已归档', ...(repo.topics ?? []).slice(0, 5)] : (repo.topics ?? []).slice(0, 6),
		}
	}

	/** One release, as the launcher's version list and version page expect it. */
	function toVersion(release: GitHubRelease): ContentVersion {
		return {
			id: release.tag_name,
			name: release.name ?? release.tag_name,
			versionNumber: release.tag_name,
			publishedAt: release.published_at ?? undefined,
			channel: release.prerelease ? 'beta' : 'release',
			// The release notes are this version's changelog.
			body: release.body ?? undefined,
			// The release's own page, for opening it on GitHub.
			url: release.html_url ?? undefined,
			// Every asset the reader might want, so a release with one jar per
			// loader can be chosen between rather than guessed at.
			files: downloadableAssets(release.assets ?? []).map((asset) => ({
				id: asset.name,
				name: asset.name,
				size: asset.size,
			})),
		}
	}

	api.register({
		/**
		 * There is no catalogue to browse, so "browsing" is exactly the user's own
		 * list, narrowed to the tab being viewed and to what the search box says. A
		 * repo that cannot be read is skipped rather than failing the whole page,
		 * since one typo in one entry should not blank the list.
		 */
		async browse(request: ContentQuery): Promise<ContentPage> {
			const needle = request.query?.trim().toLowerCase() ?? ''
			const list = (await entries()).filter(
				// An entry with no type was added before types existed, or by hand;
				// showing it everywhere is friendlier than hiding it entirely.
				(entry) => !entry.type || entry.type === request.contentType,
			)
			const matching = needle
				? list.filter((entry) => entry.repo.toLowerCase().includes(needle))
				: list

			const items: ContentCard[] = []
			for (const entry of matching) {
				try {
					const repo = await rest<GitHubRepo>(`/repos/${entry.repo}`)
					items.push(toCard(repo, request.contentType, undefined, entry.name))
				} catch (error) {
					api.log(`跳过 ${entry.repo}：${String(error)}`)
				}
			}
			return { items, total: items.length }
		},

		async detail(id: string, contentType: string): Promise<ContentProject> {
			const [repo, releases, description, entry] = await Promise.all([
				rest<GitHubRepo>(`/repos/${id}`),
				rest<GitHubRelease[]>(`/repos/${id}/releases?per_page=30`).catch(
					() => [] as GitHubRelease[],
				),
				readme(id),
				entryFor(id),
			])

			return {
				...toCard(repo, contentType, id, entry?.name),
				body: description,
				license:
					repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
						? repo.license.name
						: undefined,
				links: [{ label: 'GitHub', url: repo.html_url }],
				versions: releases.filter((release) => !release.draft).map(toVersion),
			}
		},

		async versions(id: string): Promise<ContentVersion[]> {
			const releases = await rest<GitHubRelease[]>(`/repos/${id}/releases?per_page=50`)
			return releases.filter((release) => !release.draft).map(toVersion)
		},

		/**
		 * The download is one asset of a release: the one the reader picked, or the
		 * one the entry's rule chooses. No hash is offered — GitHub publishes no
		 * digest for release assets, so the launcher records the file unverified.
		 */
		async resolveDownload(
			id: string,
			versionId?: string,
			fileId?: string,
		): Promise<DownloadDescriptor> {
			const release = versionId
				? await rest<GitHubRelease>(
						`/repos/${id}/releases/tags/${encodeURIComponent(versionId)}`,
					)
				: await rest<GitHubRelease>(`/repos/${id}/releases/latest`)

			const assets = release.assets ?? []
			// A file the reader picked outranks the entry's rule: they chose it.
			const asset = fileId
				? assets.find((candidate) => candidate.name === fileId)
				: pickAsset(assets, await entryFor(id), await assetMode())

			if (!asset) {
				throw new Error(
					fileId
						? `${release.tag_name} 里没有名为「${fileId}」的文件。`
						: `${release.tag_name} 里没有符合条件的资产。` +
								`请在内容源设置里调整该条目的匹配规则，或换一个版本。`,
				)
			}

			const headers: Record<string, string> = { accept: 'application/octet-stream' }
			const value = await token()
			if (value) headers.authorization = `Bearer ${value}`

			return {
				url: asset.browser_download_url,
				fileName: asset.name,
				// A private repository's asset URL needs the same auth the API call
				// used; a public one downloads fine without it.
				headers: value ? headers : undefined,
			}
		},

		/**
		 * Compare each installed item against its repo's latest release tag. A
		 * repository that cannot be read is reported as current rather than as an
		 * error: a background check should stay quiet, and the install list is the
		 * place a broken entry gets noticed.
		 */
		async checkUpdate(items: UpdateQueryItem[]): Promise<UpdateResult[]> {
			const results: UpdateResult[] = []
			for (const item of items) {
				try {
					const release = await rest<GitHubRelease>(`/repos/${item.id}/releases/latest`)
					const tag = release.tag_name
					if (tag && tag !== item.currentVersionId) {
						results.push({
							id: item.id,
							latestVersionId: tag,
							latestVersionName: release.name ?? tag,
						})
					} else {
						results.push({ id: item.id })
					}
				} catch (error) {
					api.log(`检查 ${item.id} 更新失败：${String(error)}`)
					results.push({ id: item.id })
				}
			}
			return results
		},
	})
}
