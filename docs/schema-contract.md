# Schema 契约（Python ↔ server 跨语言正本）

- 当前版本：**v2**（两边 `schema_meta` 均应为 2；见「迁移清单」）。
- 正本位置：Python `src/muse_me/storage.py`（`SCHEMA_SQL` + `migrate()`），
  server `server/src/infrastructure/sqlite/database.ts`（`SCHEMA_SQL` + `migrateDatabase()`）。
- 本文档是两边 schema 的**并集**：新库建表时两边直接含 v2 结构；
  旧库靠迁移升级，不靠 `CREATE TABLE IF NOT EXISTS` 补结构。
- 漂移测试直接解析下文「契约表」逐表比对（Python `tests/test_batch3_schema_migration.py`，
  server `server/tests/schema-contract.test.ts`）：契约改了、代码没跟上，
  测试即失败；反之代码改了、契约没跟上，同样失败。
- 本批只定 schema 与迁移，不改时间戳/id 口径（见「口径现状」，只记录）。

## 契约表（正本）

每表一节，表格第一列即列名（测试解析用）。类型为 SQLite 声明类型；
未标 NOT NULL 的列均可空。索引：`idx_run_events_run ON run_events(run_id, seq)`，两边同名同义。

### schema_meta

| 列 | 类型 | 约束 |
| --- | --- | --- |
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

说明：版本行键名两边不同，见「允许的差异清单」第 2 条；值均为目标版本号（当前 2）。

### users

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| created_at | TEXT | NOT NULL DEFAULT '' |

说明：仅 Python 有此表，见「允许的差异清单」第 1 条。

### chats

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| title | TEXT | NOT NULL DEFAULT '' |
| kind | TEXT | NOT NULL DEFAULT 'main' |
| feed_item_id | TEXT | 可空 |
| created_at | TEXT | NOT NULL DEFAULT '' |
| updated_at | TEXT | NOT NULL DEFAULT '' |

### messages

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| chat_id | TEXT | NOT NULL |
| role | TEXT | NOT NULL |
| content | TEXT | NOT NULL DEFAULT '' |
| created_at | TEXT | NOT NULL DEFAULT '' |

### runs

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| chat_id | TEXT | 可空 |
| script_id | TEXT | 可空 |
| job_id | TEXT | 可空 |
| scene | TEXT | NOT NULL DEFAULT 'chat' |
| source | TEXT | NOT NULL DEFAULT 'chat' |
| status | TEXT | NOT NULL DEFAULT 'running' |
| cost_usd | REAL | NOT NULL DEFAULT 0 |
| tokens | INTEGER | NOT NULL DEFAULT 0 |
| harness_version | TEXT | NOT NULL DEFAULT '' |
| error | TEXT | NOT NULL DEFAULT '' |
| created_at | TEXT | NOT NULL DEFAULT '' |
| updated_at | TEXT | NOT NULL DEFAULT '' |

说明：tokens 与 harness_version 由 v2 补齐（此前仅 Python 有）。

### run_events

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| run_id | TEXT | NOT NULL |
| seq | INTEGER | NOT NULL DEFAULT 0 |
| type | TEXT | NOT NULL |
| payload | TEXT | NOT NULL DEFAULT '{}' |
| created_at | TEXT | NOT NULL DEFAULT '' |

说明：UNIQUE(run_id, seq)；新库含 FOREIGN KEY(run_id) REFERENCES runs(id)，旧库见差异第 4 条。

### approvals

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| run_id | TEXT | NOT NULL |
| step_index | INTEGER | NOT NULL DEFAULT 0 |
| action | TEXT | NOT NULL DEFAULT '' |
| risk | TEXT | NOT NULL DEFAULT 'write' |
| amount_usd | REAL | 可空 |
| status | TEXT | NOT NULL DEFAULT 'pending' |
| reason | TEXT | NOT NULL DEFAULT '' |
| created_at | TEXT | NOT NULL DEFAULT '' |
| decided_at | TEXT | NOT NULL DEFAULT '' |

说明：新库含 FOREIGN KEY(run_id) REFERENCES runs(id)，旧库见差异第 4 条。

### memories

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| content | TEXT | NOT NULL DEFAULT '' |
| level | TEXT | NOT NULL DEFAULT 'inference' |
| status | TEXT | NOT NULL DEFAULT 'pending' |
| source | TEXT | NOT NULL DEFAULT '' |
| created_at | TEXT | NOT NULL DEFAULT '' |

### scripts

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| name | TEXT | NOT NULL |
| description | TEXT | NOT NULL DEFAULT '' |
| doc | TEXT | NOT NULL DEFAULT '{}' |
| current_version | INTEGER | NOT NULL DEFAULT 1 |
| origin_chat_id | TEXT | 可空 |
| origin_feed_item_id | TEXT | 可空 |
| created_at | TEXT | NOT NULL DEFAULT '' |
| updated_at | TEXT | NOT NULL DEFAULT '' |

### script_versions

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| script_id | TEXT | NOT NULL |
| version | INTEGER | NOT NULL |
| doc | TEXT | NOT NULL DEFAULT '{}' |
| created_at | TEXT | NOT NULL DEFAULT '' |

说明：UNIQUE(script_id, version)。

### jobs

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| name | TEXT | NOT NULL DEFAULT '' |
| script_id | TEXT | NOT NULL |
| script_version | INTEGER | 可空 |
| trigger_type | TEXT | NOT NULL DEFAULT 'time' |
| trigger_spec | TEXT | NOT NULL DEFAULT '{}' |
| params | TEXT | NOT NULL DEFAULT '{}' |
| enabled | INTEGER | NOT NULL DEFAULT 1 |
| next_fire_at | TEXT | NOT NULL DEFAULT '' |
| created_at | TEXT | NOT NULL DEFAULT '' |

### job_runs

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| job_id | TEXT | NOT NULL |
| run_id | TEXT | 可空 |
| script_version | INTEGER | 可空 |
| status | TEXT | NOT NULL DEFAULT 'running' |
| attempt | INTEGER | NOT NULL DEFAULT 1 |
| error | TEXT | NOT NULL DEFAULT '' |
| started_at | TEXT | NOT NULL DEFAULT '' |
| finished_at | TEXT | NOT NULL DEFAULT '' |

### feed_items

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| title | TEXT | NOT NULL DEFAULT '' |
| summary | TEXT | NOT NULL DEFAULT '' |
| source | TEXT | NOT NULL DEFAULT '' |
| url | TEXT | NOT NULL DEFAULT '' |
| topic | TEXT | NOT NULL DEFAULT '' |
| entities | TEXT | NOT NULL DEFAULT '{}' |
| published_at | TEXT | 可空 |
| prompt_version | INTEGER | 可空 |
| created_at | TEXT | NOT NULL DEFAULT '' |

说明：published_at 可空是硬性口径（无时间存 NULL，不编造）；Python 旧库的 NOT NULL 由 v2 迁移重建消除。

### prompts

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| key | TEXT | NOT NULL |
| version | INTEGER | NOT NULL |
| content | TEXT | NOT NULL DEFAULT '' |
| created_at | TEXT | NOT NULL DEFAULT '' |

说明：UNIQUE(user_id, key, version)。

### notifications

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| kind | TEXT | NOT NULL DEFAULT 'info' |
| title | TEXT | NOT NULL DEFAULT '' |
| body | TEXT | NOT NULL DEFAULT '' |
| read | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | NOT NULL DEFAULT '' |

### secrets_ref

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| name | TEXT | NOT NULL |
| ref | TEXT | NOT NULL |
| created_at | TEXT | NOT NULL DEFAULT '' |

说明：UNIQUE(user_id, name)；只存引用，永不存明文。

### files

| 列 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | NOT NULL |
| name | TEXT | NOT NULL |
| kind | TEXT | NOT NULL DEFAULT '' |
| ref | TEXT | NOT NULL DEFAULT '' |
| size | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | NOT NULL DEFAULT '' |

### run_snapshots

| 列 | 类型 | 约束 |
| --- | --- | --- |
| run_id | TEXT | PRIMARY KEY |
| kind | TEXT | NOT NULL DEFAULT '' |
| payload | TEXT | NOT NULL DEFAULT '{}' |
| updated_at | TEXT | NOT NULL DEFAULT '' |

说明：来源见「允许的差异清单」第 3 条；Python 侧为占位表（不读）。

## 允许的差异清单

除下表外，两边表/列集合必须与上文契约表一致，否则漂移测试失败。

1. users 表仅 Python 有，server 无。方向：Python 有、server 缺。
   原因：server 用户身份来自启动配置与内存会话，没有任何 users 表消费者。
   消除计划：无（不为对称而建无用表）；server 未来持久化用户时再补同名表，届时删本条。
2. schema_meta 版本行键名不同：Python 用 `version`，server 用 `schema_version`，语义相同（值均为目标版本）。
   方向：键名差异，非结构差异。原因：Python 的 `version` 键是历史遗留，旧库已用此键，
   改键会让旧库的版本行 orphan；server 的 `schema_version` 是本批新增，按任务口径命名。
   消除计划：未来大版本统一为 `schema_version`，Python 迁移先双写、双读过渡一版后再去旧键。
3. run_snapshots 表来源：此前仅 server 有（server 重启续跑快照），Python 无。
   本批 Python 已补同名占位表（与 server 同形），Python 续跑仍走事件重建、不读该表。
   差异至此消除，但文档仍写明其来源；未来 Python 若用快照续跑，直接复用此表，不再建新表。
4. 旧库 FK 声明：run_events / approvals 的 FOREIGN KEY 声明仅新库 CREATE TABLE 生效。
   v1 建表的旧库（两边）不强制重建，故旧库可能无 FK；这不视为漂移。
   消除计划：无强制重建（重建成本高于收益；两边连接均开 `PRAGMA foreign_keys=ON`，
   新库 FK 真实生效）。未来若需强制，可在 v3 以重建表方式补齐。
5. server runs 写路径暂未接 tokens 累计：列已存在（默认 0），但 server `addRunCost` 只写 cost_usd，
   server `RunRecord` 领域类型也暂不暴露 tokens。这不是 schema 差异（列集合一致），
   仅记录：tokens 真实累计是后续批的接线工作，本批不改。

## 口径现状（只记录，本批不改）

- 时间戳：均为 TEXT，但格式不同。Python `_now()` 为本地时区 `%Y-%m-%dT%H:%M:%S%z`
  （如 `2026-10-24T21:00:00+0800`，无冒号、无毫秒、无 Z）；
  server `nowIso()` 为 `Date.toISOString()`（UTC，毫秒，Z 后缀，如 `2026-10-24T13:00:00.000Z`）。
  两边库文件不共享、不跨库比对时间戳，故本批不统一；排序均另有 `rowid` 兜底。
  统一方向（未来）：以 UTC ISO 为准，Python 侧改 `_now()` 时需同步处理存量本地时间戳的排序语义。
- id：均为 TEXT 主键，但生成方式不同。Python 领域对象默认 `uuid.uuid4().hex`
  （32 位十六进制，无连字符）；server 用 `randomUUID()`（36 位含连字符标准 UUID）。
  两边库文件不共享、不跨库 join，故本批不统一；统一方向（未来）：以标准 UUID 文本为准。

## 迁移清单

- 框架：数据库打开时执行。Python `SqliteStore.__init__` → `init_schema()` → `migrate()`；
  server `openDatabase()` → `migrateDatabase()`。均按版本升序执行迁移列表，
  每个迁移自身幂等（先查结构再动手），重复跑不报错、不丢数据；
  高于代码版本的库不降级、不动数据。
- v1 基线：此前各表结构（server runs 无 tokens/harness_version、无 schema_meta 表；
  Python 无 run_snapshots 表；Python 旧库 feed_items.published_at 可能是 NOT NULL）。
- v2（目标版本 2；新库建表直接含以下结构，迁移只为旧库升级）：

  - Python `migrate()` → `_migrate_to_2()`：
    - feed_items.published_at 改可空（SQLite 标准重建）：
      建 `feed_items_new`（与新定义同形，published_at 可空）→
      `INSERT INTO feed_items_new (…) SELECT … FROM feed_items`（拷全量数据）→
      `DROP TABLE feed_items` → `ALTER TABLE feed_items_new RENAME TO feed_items`。
      重建前 `PRAGMA foreign_keys=OFF`（事务内禁改该 pragma，故先关后恢复），
      全程包在独立事务内；已是可空或无表时跳过。
    - `CREATE TABLE IF NOT EXISTS run_snapshots (…)`（与上文契约同形）。
    - 落版本行：`INSERT OR REPLACE INTO schema_meta(key, value) VALUES('version', '2')`。
  - server `migrateDatabase()` → v2 迁移：
    - `runs` 补列（逐列先查 `PRAGMA table_info(runs)`，缺失才执行）：
      `ALTER TABLE runs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0`；
      `ALTER TABLE runs ADD COLUMN harness_version TEXT NOT NULL DEFAULT ''`。
    - 新库 `run_events` / `approvals` 的 CREATE TABLE 语句已含 FK 声明（旧库不重建，见差异第 4 条）。
    - 落版本行：`INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '2')`。
  - 本批无 v3 及以上迁移；迁移列表保留空位结构（后续版本按升序追加）。

## 事务包裹点（BE-3）

- Python `SqliteStore.transaction()`（上下文管理器，BEGIN IMMEDIATE，异常回滚、成功提交，
  事务内 `_exec` 不中途提交；嵌套调用加入外层事务）：
  `create_script`（脚本行＋版本行）、`update_script`（同对）、
  `replace_feed_items`（DELETE＋多插）、`seed_if_empty` 整批（经 `store.transaction()`，
  无该方法的 store 退化为顺序写入）。
- server `database.ts` 的 `transaction(db, fn)`（手动 BEGIN IMMEDIATE / COMMIT / ROLLBACK，
  嵌套调用加入外层事务；异常回滚）：
  `SqliteScriptStore.createScript` / `updateScript`（脚本行＋版本行）、
  `SqliteFeedStore.replaceFeedItems`（DELETE＋多插）、
  `seedIfEmpty` 整批（从各 store 的 `database` 句柄取唯一共享连接包事务；
  无句柄或多连接时退化为顺序写入——生产组合根的六个 store 共享同一连接，故生产路径走事务；
  组合根本批未改，`seedIfEmpty` 的事务化不依赖组合根传参）。

## 漂移测试

- Python：`tests/test_batch3_schema_migration.py`（解析本文档契约表，与新库 `sqlite_master` /
  `PRAGMA table_info` 比对；另含迁移与事务测试）。
- server：`server/tests/schema-contract.test.ts`（解析本文档契约表，与新库比对；
  users 表缺失是契约明文允许的唯一缺表；另含旧库迁移与事务测试）。
