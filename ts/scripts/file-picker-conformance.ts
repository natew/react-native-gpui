import { FilePicker } from '../src/apis'

let request: unknown = null

globalThis.__rngpui_pickPaths = (json: string) => {
    request = JSON.parse(json)
    queueMicrotask(() => {
        globalThis.__rngpui_filePickerDone?.(JSON.stringify({
            id: (request as { id: number }).id,
            ok: true,
            paths: ["/tmp/a.txt", "/tmp/b.png"],
        }))
    })
}

const pathsFromHost = await FilePicker.pickPaths({
    multiple: true,
    files: true,
    directories: true,
    prompt: 'Attach file',
})

assert(pathsFromHost.length === 2 && pathsFromHost[1] === '/tmp/b.png', 'pickPaths should resolve selected paths')
assert((request as { files: boolean }).files === true, 'request should allow files')
assert((request as { directories: boolean }).directories === true, 'request should allow directories')
assert((request as { multiple: boolean }).multiple === true, 'request should allow multiple selection')
assert((request as { prompt: string }).prompt === 'Attach file', 'request should include prompt')

const paths = FilePicker._parse(["/tmp/a.txt", "/tmp/b.png"])
assert(paths.length === 2 && paths[1] === '/tmp/b.png', 'parser should return selected paths')
assert(FilePicker._parse([]).length === 0, 'parser should accept canceled empty selection')
assert(FilePicker._parse(["", 1, "/tmp/c"]).join(',') === '/tmp/c', 'parser should discard invalid path values')

console.log('FILE_PICKER_CONFORMANCE_PASS paths=2')

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
        console.error(`FILE_PICKER_CONFORMANCE_FAIL ${message}`)
        process.exit(1)
    }
}
