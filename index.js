#!/usr/bin/env node

const path = require('path').posix
const fs = require('fs/promises')
const { performance } = require('perf_hooks')

// Util
const util = {
	requireUncached: (moduleName) => {
		delete require.cache[require.resolve(moduleName)]
		return require(moduleName)
	},
	starting: (taskName) => {
		console.log(`Starting '${taskName}'...`)
		return performance.now()
	},
	finished: (taskName, start) => {
		let elapsed = Math.round(performance.now() - start)
		elapsed = elapsed >= 1000 ? +(elapsed / 1000).toFixed(2) + ' s' : Math.round(elapsed) + ' ms'
		elapsed = elapsed.toString()
		console.log(`Finished '${taskName}' after ${elapsed}`)
	},
	readdir: async (path, extname = null, prependPath = true) => {
		let files = await fs.readdir(path)
		if (prependPath) {
			files = files.map((file) => `${path}/${file}`)
		}
		if (extname) {
			files = files.filter((file) => file.endsWith(extname))
		}
		return files
	},
	writeFile: async (paths, contents) => {
		return await Promise.all(
			paths.map((path, index) => {
				return fs.writeFile(path, contents[index])
			})
		)
	},
	readFile: async (paths) => {
		return await Promise.all(
			paths.map((path) => {
				return fs.readFile(path, 'utf8')
			})
		)
	},
	rm: async (paths) => {
		return await Promise.all(
			paths.map((path) => {
				return fs.rm(path, { recursive: true }).catch((e) => undefined)
			})
		)
	},
}

// Arguments
// replace backslash, in case of running on windows
const src = process.argv[process.argv.length - 3].replace(/\\/g, '/')
const dst = process.argv[process.argv.length - 2].replace(/\\/g, '/')

// Get data
const getData = () => util.requireUncached(path.resolve(src) + '/data.json')
let data = getData()

// Edge init
const edge = require('edge.js').default
edge.mount(path.resolve(src))

// Render edge file to html code
async function renderToHtml(filename) {
	let content = await edge.render(filename.split('/').pop(), data)
	content = await importSvg(content)
	content = await importText(content)

	// if build, beautify
	if (process.argv.includes('--build')) {
		content = require('condense-newlines')(content)
		content = require('js-beautify').html(content, {
			indent_size: 2,
			indent_with_tabs: true,
			unformatted: ['pre', 'code'],
		})
	}
	return content
}

// Render files
async function html(files = null) {
	const start = util.starting('html')

	// if empty files, render all
	files = files === null ? await allFiles() : files

	const destFiles = files.map(setDest)
	let contents = await Promise.all(files.map(renderToHtml))
	await util.writeFile(destFiles, contents)

	util.finished('html', start)
}

// Watch files
function htmlWatch() {
	require('chokidar').watch(src, { ignoreInitial: true })
		.on('all', (event, target) => {
			setTimeout(async () => {
				// replace backslash, in case of running on windows
				target = target.replace(/\\/g, '/')

				const parsed = path.parse(target)

				let targets = []
				switch (parsed.ext) {
					case '.edge':
						switch (event) {
							case 'add':
							case 'change':
								targets = await getChangedTarget(parsed, target)
								break
							case 'unlink':
								const removedTarget = target.replace(src, dst).slice(0, -4) + 'html'
								await util.rm([removedTarget])
								break
						}
						break
					case '.json':
						// if data.json (main data)
						// update data
						data = getData()
						// render all
						targets = await allFiles()
						break
				}
				await html(targets)
			}, 200)
		})
		.on('ready', () => {
			console.log('Ready for changes')
		})
}

// Get all .edge files
async function allFiles() {
	return await util.readdir(src, '.edge')
}

// Set destination file, based on source but different location and extension
function setDest(file) {
	return file.replace(src, dst).slice(0, -4) + 'html'
}

// Get related files changed
async function getChangedTarget(changed, target) {
	let targets = []

	// If what changes is a partial file,
	// the first letter of the partial file name is an underscore,
	// example: _sidebar.edge
	if (changed.name.startsWith('_')) {
		// get all content
		let files = await allFiles()
		let contents = await util.readFile(files)
		for (const [index, content] of contents.entries()) {
			// check if each content contains filename, if found, add to target list
			if (content.includes(changed.name)) {
				targets.push(files[index])
			}
		}
	} else {
		targets.push(target)
	}
	return targets
}

async function importSvg(content) {
	let svg = content.match(/@svg\(\s*(['"])(.+?)\1\s*(,\s*({.+?})\s*)?\)/g)
	if (svg) {
		for (const tag of svg) {
			const arr = tag.replace(/'/g, '').match(/\(([^)]+)\)/)[1].split(',')
			const tagPath = arr[0]
			const tagAttr = arr[1]
			let tagContent = await require('axios').default.get(tagPath).then(res => res.data.trim())
			if (tagAttr) {
				tagContent = tagContent.replace('<svg', `<svg ${tagAttr}`)
			}
			content = content.replace(tag, tagContent)
		}
	}
	return content
}

async function importText(content) {
	let text = content.match(/@text\(\s*(['"])(.+?)\1\s*(,\s*({.+?})\s*)?\)/g)
	if (text) {
		for (const tag of text) {
			const url = tag.replace(/'/g, '').match(/\(([^)]+)\)/)[1]
			let textContent = await require('axios').default.get(url).then(res => res.data.trim())
			content = content.replace(tag, textContent)
		}
	}
	return content
}

void (async () => {
	if (process.argv.includes('--dev')) {
		htmlWatch()
	}
	if (process.argv.includes('--build')) {
		await html()
	}
})()
