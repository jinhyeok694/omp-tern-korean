--!strict
-- 한국어 번역 (Tern 쪽)
--
-- Tern은 내장 팔레트 명령의 이름을 바꾸거나 숨기는 API가 없습니다. 그래서 같은 명령을 실행하는
-- 한국어 행을 "한국어" 그룹에 더합니다. 행 id는 영어 낱말이 없는 16진수라서, 영어로 검색하면
-- 원래 행만 나오고 한국어로 검색하면 한국어 행만 나옵니다 (팔레트는 id, 이름, 그룹을 검색합니다).
-- 내장 명령이 지금 쓸 수 없거나 이 Tern 버전에 없으면 한국어 행도 숨깁니다.
--
-- 번역표는 하루에 한 번 GitHub에서 새로 받습니다. 받은 것이 플러그인에 들어 있는 것보다 새것이면 씁니다.

local GROUP = "한국어"
local ROWS_KEY = "palette_rows"
local CHECKED_KEY = "catalog_checked_at"
local ETAG_KEY = "catalog_etag"
local REVISION_KEY = "catalog_revision"
local CATALOG_URL = "https://raw.githubusercontent.com/jinhyeok694/omp-tern-korean/main/tern-plugin/ko.json"
local CHECK_INTERVAL_S = 24 * 60 * 60
-- 다른 창이 받은 새 번역표를 이 창도 쓰도록, 이만큼마다 저장된 revision을 봅니다.
local RELOAD_POLL_MS = 10 * 60 * 1000
local MAX_CATALOG_BYTES = 4 * 1024 * 1024
local CACHED_PATH = tern.plugin.data .. "/ko.json"

type Catalog = { version: number, revision: number, actions: { [string]: string } }

local function decodeCatalog(text: string): Catalog?
	local ok, parsed = pcall(tern.json.decode, text)
	if not ok or type(parsed) ~= "table" or parsed.version ~= 1 or type(parsed.actions) ~= "table" then
		return nil
	end
	if type(parsed.revision) ~= "number" then
		parsed.revision = 0
	end
	return parsed :: Catalog
end

local function readCatalog(path: string): Catalog?
	local ok, text = pcall(tern.fs.read, path, MAX_CATALOG_BYTES)
	if not ok then
		return nil
	end
	return decodeCatalog(text)
end

local catalog: Catalog = readCatalog("ko.json") or { version = 1, revision = 0, actions = {} }
local cached = readCatalog(CACHED_PATH)
if cached and cached.revision > catalog.revision then
	catalog = cached
end

local function rowsEnabled(): boolean
	return tern.kv.get(ROWS_KEY) ~= false
end

local function hexId(text: string): string
	return "r" .. (string.gsub(text, ".", function(char: string): string
		return string.format("%02x", string.byte(char))
	end))
end

-- 한 번 등록한 id는 지울 수 없어서, 번역표에서 빠진 명령은 available에서 숨깁니다.
local registered: { [string]: boolean } = {}

local function registerRows()
	local targets = {}
	for target in pairs(catalog.actions) do
		table.insert(targets, target)
	end
	table.sort(targets)
	for _, target in targets do
		registered[target] = true
		tern.command({
			id = hexId(target),
			title = catalog.actions[target],
			group = GROUP,
			available = function(cx): boolean
				if not rowsEnabled() or catalog.actions[target] == nil then
					return false
				end
				local ok, action = pcall(function()
					return cx.actions:describe(target)
				end)
				return ok and action.available == true
			end,
			run = function(cx)
				cx:command(target)
			end,
		})
	end
end

registerRows()

local function adopt(next: Catalog)
	catalog = next
	registerRows()
end

local function checkForUpdate(force: boolean, done: ((string, any?) -> ())?)
	local now = os.time()
	local last = tern.kv.get(CHECKED_KEY)
	if not force and type(last) == "number" and now - last < CHECK_INTERVAL_S then
		return
	end
	tern.kv.set(CHECKED_KEY, now)
	local headers: { [string]: string } = {}
	local etag = tern.kv.get(ETAG_KEY)
	if type(etag) == "string" and tern.fs.exists(CACHED_PATH) then
		headers["If-None-Match"] = etag
	end
	tern.fetch(CATALOG_URL, { headers = headers, timeout_ms = 15000 }, function(result, cx)
		local message: string
		if result.error then
			message = "번역표를 받지 못했습니다: " .. result.error
		elseif result.status == 304 then
			message = "새 번역이 없습니다."
		elseif result.status ~= 200 then
			message = "번역표를 받지 못했습니다: HTTP " .. tostring(result.status)
		else
			local next = decodeCatalog(result.body)
			if not next then
				message = "받은 번역표를 읽지 못했습니다."
			else
				tern.fs.mkdir(tern.plugin.data)
				tern.fs.write(CACHED_PATH, result.body)
				tern.kv.set(ETAG_KEY, result.headers.etag)
				tern.kv.set(REVISION_KEY, next.revision)
				if next.revision > catalog.revision then
					adopt(next)
					message = "새 번역을 받았습니다 (" .. tostring(next.revision) .. ")."
				else
					message = "새 번역이 없습니다."
				end
			end
		end
		if done then
			done(message, cx)
		end
	end)
end

local function pollCachedRevision()
	local revision = tern.kv.get(REVISION_KEY)
	if type(revision) == "number" and revision > catalog.revision then
		local next = readCatalog(CACHED_PATH)
		if next and next.revision > catalog.revision then
			adopt(next)
		end
	end
	tern.timer(RELOAD_POLL_MS, pollCachedRevision)
end

tern.timer(3000, function()
	checkForUpdate(false, nil)
end)
tern.timer(RELOAD_POLL_MS, pollCachedRevision)

tern.command({
	id = "toggle_rows",
	title = "한국어 명령 행 켜기/끄기",
	group = GROUP,
	run = function(cx)
		local enabled = not rowsEnabled()
		tern.kv.set(ROWS_KEY, enabled)
		cx:toast("info", if enabled then "한국어 명령 행을 켰습니다." else "한국어 명령 행을 껐습니다.")
	end,
})

tern.command({
	id = "update_catalog",
	title = "한국어 번역: 새 번역 받기",
	group = GROUP,
	run = function(cx)
		checkForUpdate(true, function(message: string, callbackCx: any)
			local target = callbackCx or cx
			target:toast("info", message)
		end)
	end,
})

-- 번역표를 만들 때 쓰는 명령: 이 Tern에 있는 팔레트 명령 전체를 플러그인 데이터 폴더에 씁니다.
tern.command({
	id = "dump_actions",
	title = "한국어 번역: 내장 명령 목록 내보내기",
	group = GROUP,
	run = function(cx)
		local path = tern.plugin.data .. "/actions.json"
		tern.fs.mkdir(tern.plugin.data)
		tern.fs.write(path, tern.json.encode(cx.actions:list(), true))
		cx:toast("info", "내장 명령 목록을 저장했습니다.", path)
	end,
})
