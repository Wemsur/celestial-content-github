/**
 * Picking one release asset out of many.
 *
 * A GitHub release can carry a dozen files — the jar, its sources jar, a
 * javadoc jar, checksums, a dev build, per-platform bundles. Which one the user
 * wants cannot be inferred, so the entry says, and this module applies it:
 *
 * 1. an explicit `rule` (a regular expression the author writes) wins, and if it
 *    matches nothing the release is treated as having no usable asset rather
 *    than silently falling back to a guess;
 * 2. otherwise a preset decides: any `.jar`, the first asset, or the largest;
 * 3. `exclude` removes names first, and `prefer` orders what is left by how many
 *    of its tokens the name contains, so `prefer: fabric,1.21` picks the Fabric
 *    build for 1.21 out of several loader builds.
 */

export interface ReleaseAsset {
	name: string
	size: number
	browser_download_url: string
	content_type?: string
}

/** One manually-added repository and the rules that apply to it. */
export interface MatchEntry {
	repo: string
	/** A display name the user gave the entry; shown instead of the repo name. */
	name?: string
	/** Which content type this entry is, so it only shows under its own tab. */
	type?: string
	/** A regular expression the asset name must match. */
	rule?: string
	/** Comma-separated tokens; more matches rank an asset higher. */
	prefer?: string
	/** Comma-separated tokens; any match drops the asset. */
	exclude?: string
}

export type AssetMode = 'jar' | 'first' | 'largest'

/**
 * Names that are almost never the thing to install. Only applied by the `jar`
 * preset — an explicit rule is the author's business, not ours to second-guess.
 */
const JAR_NOISE = ['sources', 'javadoc', 'dev', 'api', 'slim', 'sourcesjar']

/** Files that accompany a release rather than being it. */
const NOT_A_DOWNLOAD = /\.(sha1|sha256|sha512|md5|asc|sig|txt|json)$/i

/**
 * The assets worth offering a choice between: everything except the checksums
 * and signatures that sit beside a release's files.
 */
export function downloadableAssets(assets: ReleaseAsset[]): ReleaseAsset[] {
	return assets.filter((asset) => !NOT_A_DOWNLOAD.test(asset.name))
}

export function splitTokens(value: string | undefined): string[] {
	if (!value) return []
	return value
		.split(',')
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token.length > 0)
}

/**
 * The asset to install, or undefined when nothing fits.
 *
 * Throws only for a malformed rule: a bad regex is an authoring mistake worth
 * surfacing, while "no asset matched" is an ordinary outcome the UI explains.
 */
export function pickAsset(
	assets: ReleaseAsset[],
	entry: MatchEntry | undefined,
	mode: AssetMode,
): ReleaseAsset | undefined {
	let candidates = downloadableAssets(assets)
	if (candidates.length === 0) return undefined

	const excluded = splitTokens(entry?.exclude)
	if (excluded.length > 0) {
		candidates = candidates.filter((asset) => {
			const name = asset.name.toLowerCase()
			return !excluded.some((token) => name.includes(token))
		})
		if (candidates.length === 0) return undefined
	}

	if (entry?.rule) {
		let pattern: RegExp
		try {
			pattern = new RegExp(entry.rule, 'i')
		} catch (error) {
			throw new Error(
				`资产匹配规则不是合法的正则表达式：${entry.rule}（${String(error)}）`,
			)
		}
		const matched = candidates.filter((asset) => pattern.test(asset.name))
		if (matched.length === 0) return undefined
		candidates = matched
	} else if (mode === 'jar') {
		const jars = candidates.filter((asset) => {
			const name = asset.name.toLowerCase()
			return (
				name.endsWith('.jar') &&
				!JAR_NOISE.some((noise) => name.includes(noise))
			)
		})
		if (jars.length === 0) return undefined
		candidates = jars
	}

	if (mode === 'largest') {
		return [...candidates].sort((a, b) => b.size - a.size)[0]
	}

	const preferred = splitTokens(entry?.prefer)
	if (preferred.length > 0) {
		const scored = candidates.map((asset) => {
			const name = asset.name.toLowerCase()
			return {
				asset,
				score: preferred.filter((token) => name.includes(token)).length,
			}
		})
		const best = Math.max(...scored.map((scored) => scored.score))
		if (best > 0) {
			// Ties break on size, so a per-platform build set still resolves to
			// something deterministic rather than to release order.
			return scored
				.filter((scored) => scored.score === best)
				.sort((a, b) => b.asset.size - a.asset.size)[0].asset
		}
	}

	return candidates[0]
}
