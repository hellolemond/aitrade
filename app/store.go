package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/egoist/mygo/plugins/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT PRIMARY KEY,
  pos    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  candle_time INTEGER NOT NULL,
  close       REAL    NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  done_at     INTEGER
);
CREATE TABLE IF NOT EXISTS task_steps (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  account TEXT    NOT NULL,
  text    TEXT    NOT NULL,
  detail  TEXT    NOT NULL DEFAULT '',
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS task_steps_task ON task_steps(task_id, seq);
`

// DefaultWatchlist 是首次启动时的自选列表。
var DefaultWatchlist = []string{"BTCUSDT"}

// StrategyState 是 H 方案已处理到的位置，用来判断有没有新信号。
type StrategyState struct {
	// State 1 = 多头，0 = 空头
	State int `json:"state"`
	// LastCandleTime 是已处理的最后一根已收盘日线的开盘时间（毫秒）
	LastCandleTime    int64 `json:"lastCandleTime"`
	LastRebalanceYear int   `json:"lastRebalanceYear"`
}

// Step 是操作记录里的一步。
type Step struct {
	ID      int64  `json:"id"`
	Account string `json:"account"`
	Text    string `json:"text"`
	Detail  string `json:"detail"`
	// DoneAt 为标记已操作的时间（毫秒），未操作为 0
	DoneAt int64 `json:"doneAt"`
}

// Task 是一条操作记录：一次信号（建仓、转多、转空、再平衡）要做的全部步骤。
type Task struct {
	ID         int64   `json:"id"`
	Kind       string  `json:"kind"`
	Title      string  `json:"title"`
	CandleTime int64   `json:"candleTime"`
	Close      float64 `json:"close"`
	Note       string  `json:"note"`
	CreatedAt  int64   `json:"createdAt"`
	// Status: pending 待操作、done 已完成、superseded 被更新的信号取代
	Status string `json:"status"`
	DoneAt int64  `json:"doneAt"`
	Steps  []Step `json:"steps"`
}

// NewStep 是新建记录时的一步。
type NewStep struct {
	Account string `json:"account"`
	Text    string `json:"text"`
	Detail  string `json:"detail"`
}

// NewTask 是页面检测到信号后提交的记录。
type NewTask struct {
	Kind       string    `json:"kind"`
	Title      string    `json:"title"`
	CandleTime int64     `json:"candleTime"`
	Close      float64   `json:"close"`
	Note       string    `json:"note"`
	Steps      []NewStep `json:"steps"`
	// Supersede 为 true 时，把之前未完成的记录标为「已被取代」
	Supersede bool `json:"supersede"`
}

// Store 是本地 SQLite 数据库：自选币种、策略进度、操作记录。
type Store struct {
	db *sqlite.DB
}

func openStore(ctx context.Context, path string) (*Store, error) {
	s := &Store{}
	return s, s.open(ctx, path)
}

// open 打开数据库并建表。App 就绪后才调用：`mygo generate` 会运行 main 到 App.Run，
// 那时不应创建数据库文件。
func (s *Store) open(ctx context.Context, path string) error {
	db, err := sqlite.Open(ctx, path, sqlite.OpenOptions{})
	if err != nil {
		return fmt.Errorf("打开数据库失败：%w", err)
	}
	for stmt := range strings.SplitSeq(schema, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := db.Execute(ctx, stmt); err != nil {
			db.Close()
			return fmt.Errorf("初始化数据库失败：%w", err)
		}
	}
	if _, err := db.Execute(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		db.Close()
		return err
	}
	s.db = db
	return nil
}

func (s *Store) close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func toInt(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case float64:
		return int64(x)
	case int:
		return int64(x)
	}
	return 0
}

func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	}
	return 0
}

func toString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	}
	return ""
}

// Watchlist 返回自选币种，按添加顺序。为空时返回默认列表。
func (s *Store) Watchlist(ctx context.Context) ([]string, error) {
	rows, err := s.db.Query(ctx, "SELECT symbol FROM watchlist ORDER BY pos")
	if err != nil {
		return nil, err
	}
	list := make([]string, 0, len(rows.Values))
	for _, r := range rows.Values {
		list = append(list, toString(r[0]))
	}
	if len(list) == 0 {
		return append([]string(nil), DefaultWatchlist...), nil
	}
	return list, nil
}

// SetWatchlist 整体替换自选币种。
func (s *Store) SetWatchlist(ctx context.Context, symbols []string) error {
	if len(symbols) == 0 {
		return errors.New("自选列表至少保留一个币种")
	}
	stmts := []sqlite.Statement{{SQL: "DELETE FROM watchlist"}}
	seen := map[string]bool{}
	for i, sym := range symbols {
		sym = strings.ToUpper(strings.TrimSpace(sym))
		if sym == "" || seen[sym] {
			continue
		}
		seen[sym] = true
		stmts = append(stmts, sqlite.Statement{SQL: "INSERT INTO watchlist(symbol, pos) VALUES (?, ?)", Args: []any{sym, i}})
	}
	_, err := s.db.Transaction(ctx, stmts)
	return err
}

func (s *Store) getKV(ctx context.Context, key string) (string, bool, error) {
	rows, err := s.db.Query(ctx, "SELECT value FROM kv WHERE key = ?", key)
	if err != nil || len(rows.Values) == 0 {
		return "", false, err
	}
	return toString(rows.Values[0][0]), true, nil
}

func kvStatements(st StrategyState) []sqlite.Statement {
	const up = "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
	return []sqlite.Statement{
		{SQL: up, Args: []any{"h.state", fmt.Sprint(st.State)}},
		{SQL: up, Args: []any{"h.lastCandleTime", fmt.Sprint(st.LastCandleTime)}},
		{SQL: up, Args: []any{"h.lastRebalanceYear", fmt.Sprint(st.LastRebalanceYear)}},
	}
}

// StrategyState 返回策略进度；从未运行过时返回 nil。
func (s *Store) StrategyState(ctx context.Context) (*StrategyState, error) {
	rows, err := s.db.Query(ctx, "SELECT key, value FROM kv WHERE key LIKE 'h.%'")
	if err != nil {
		return nil, err
	}
	if len(rows.Values) == 0 {
		return nil, nil
	}
	var st StrategyState
	for _, r := range rows.Values {
		var n int64
		fmt.Sscan(toString(r[1]), &n)
		switch toString(r[0]) {
		case "h.state":
			st.State = int(n)
		case "h.lastCandleTime":
			st.LastCandleTime = n
		case "h.lastRebalanceYear":
			st.LastRebalanceYear = int(n)
		}
	}
	return &st, nil
}

// SaveState 保存策略进度（没有新记录时，例如每天推进已处理的日线）。
func (s *Store) SaveState(ctx context.Context, st StrategyState) error {
	_, err := s.db.Transaction(ctx, kvStatements(st))
	return err
}

// CreateTask 新建一条操作记录，并在同一事务里保存策略进度，
// 保证「记录已生成」与「信号已处理」不会只成功一半。
func (s *Store) CreateTask(ctx context.Context, t NewTask, st StrategyState) (Task, error) {
	now := time.Now().UnixMilli()
	status := "pending"
	if len(t.Steps) == 0 {
		status = "done"
	}
	var stmts []sqlite.Statement
	if t.Supersede {
		stmts = append(stmts, sqlite.Statement{SQL: "UPDATE tasks SET status = 'superseded' WHERE status = 'pending'"})
	}
	taskIdx := len(stmts)
	stmts = append(stmts, sqlite.Statement{
		SQL:  "INSERT INTO tasks(kind, title, candle_time, close, note, created_at, status, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		Args: []any{t.Kind, t.Title, t.CandleTime, t.Close, t.Note, now, status, doneAtArg(status == "done", now)},
	})
	// 同一事务内，刚插入的记录就是 id 最大的那条
	for i, step := range t.Steps {
		stmts = append(stmts, sqlite.Statement{
			SQL:  "INSERT INTO task_steps(task_id, seq, account, text, detail) VALUES ((SELECT MAX(id) FROM tasks), ?, ?, ?, ?)",
			Args: []any{i, step.Account, step.Text, step.Detail},
		})
	}
	stmts = append(stmts, kvStatements(st)...)
	results, err := s.db.Transaction(ctx, stmts)
	if err != nil {
		return Task{}, err
	}
	return s.task(ctx, results[taskIdx].LastInsertID)
}

func doneAtArg(done bool, now int64) any {
	if done {
		return now
	}
	return nil
}

// Tasks 返回操作记录，新的在前。status 为空返回全部，否则只返回 pending 或 done（含已取代）。
func (s *Store) Tasks(ctx context.Context, status string, limit int) ([]Task, error) {
	where, args := "", []any{}
	switch status {
	case "pending":
		where = "WHERE status = 'pending'"
	case "done":
		where = "WHERE status <> 'pending'"
	}
	if limit <= 0 {
		limit = 200
	}
	args = append(args, limit)
	rows, err := s.db.Query(ctx,
		"SELECT id, kind, title, candle_time, close, note, created_at, status, done_at FROM tasks "+where+" ORDER BY id DESC LIMIT ?", args...)
	if err != nil {
		return nil, err
	}
	tasks := make([]Task, 0, len(rows.Values))
	index := map[int64]int{}
	ids := make([]string, 0, len(rows.Values))
	for _, r := range rows.Values {
		t := Task{
			ID: toInt(r[0]), Kind: toString(r[1]), Title: toString(r[2]), CandleTime: toInt(r[3]),
			Close: toFloat(r[4]), Note: toString(r[5]), CreatedAt: toInt(r[6]), Status: toString(r[7]),
			DoneAt: toInt(r[8]), Steps: []Step{},
		}
		index[t.ID] = len(tasks)
		tasks = append(tasks, t)
		ids = append(ids, fmt.Sprint(t.ID))
	}
	if len(ids) == 0 {
		return tasks, nil
	}
	steps, err := s.db.Query(ctx,
		"SELECT id, task_id, account, text, detail, done_at FROM task_steps WHERE task_id IN ("+strings.Join(ids, ",")+") ORDER BY task_id, seq")
	if err != nil {
		return nil, err
	}
	for _, r := range steps.Values {
		i := index[toInt(r[1])]
		tasks[i].Steps = append(tasks[i].Steps, Step{
			ID: toInt(r[0]), Account: toString(r[2]), Text: toString(r[3]), Detail: toString(r[4]), DoneAt: toInt(r[5]),
		})
	}
	return tasks, nil
}

func (s *Store) task(ctx context.Context, id int64) (Task, error) {
	all, err := s.Tasks(ctx, "", 1000)
	if err != nil {
		return Task{}, err
	}
	for _, t := range all {
		if t.ID == id {
			return t, nil
		}
	}
	return Task{}, fmt.Errorf("记录 %d 不存在", id)
}

// refreshStatus 在步骤全部完成时把记录标为已完成，有步骤被取消勾选时改回待操作。
func (s *Store) refreshStatus(ctx context.Context, taskID int64) (Task, error) {
	now := time.Now().UnixMilli()
	_, err := s.db.Execute(ctx, `
UPDATE tasks SET
  status  = CASE WHEN NOT EXISTS (SELECT 1 FROM task_steps WHERE task_id = tasks.id AND done_at IS NULL) THEN 'done' ELSE 'pending' END,
  done_at = CASE WHEN NOT EXISTS (SELECT 1 FROM task_steps WHERE task_id = tasks.id AND done_at IS NULL) THEN COALESCE(done_at, ?) ELSE NULL END
WHERE id = ? AND status <> 'superseded'`, now, taskID)
	if err != nil {
		return Task{}, err
	}
	return s.task(ctx, taskID)
}

// MarkStep 把一步标记为已操作，done 为 false 时撤销。
func (s *Store) MarkStep(ctx context.Context, stepID int64, done bool) (Task, error) {
	rows, err := s.db.Query(ctx, "SELECT task_id FROM task_steps WHERE id = ?", stepID)
	if err != nil {
		return Task{}, err
	}
	if len(rows.Values) == 0 {
		return Task{}, fmt.Errorf("步骤 %d 不存在", stepID)
	}
	taskID := toInt(rows.Values[0][0])
	if _, err := s.db.Execute(ctx, "UPDATE task_steps SET done_at = ? WHERE id = ?", doneAtArg(done, time.Now().UnixMilli()), stepID); err != nil {
		return Task{}, err
	}
	return s.refreshStatus(ctx, taskID)
}

// MarkTask 把一条记录的全部步骤标记为已操作。
func (s *Store) MarkTask(ctx context.Context, taskID int64) (Task, error) {
	if _, err := s.db.Execute(ctx, "UPDATE task_steps SET done_at = ? WHERE task_id = ? AND done_at IS NULL", time.Now().UnixMilli(), taskID); err != nil {
		return Task{}, err
	}
	return s.refreshStatus(ctx, taskID)
}

// Preferences 是基础设置。
type Preferences struct {
	// UpColor / DownColor 是 K 线涨、跌的颜色（#RRGGBB）
	UpColor   string `json:"upColor"`
	DownColor string `json:"downColor"`
}

// DefaultPreferences 是默认设置：红涨绿跌。
var DefaultPreferences = Preferences{UpColor: "#ef5350", DownColor: "#26a69a"}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Preferences 返回基础设置，未设置的项用默认值。
func (s *Store) Preferences(ctx context.Context) (Preferences, error) {
	p := DefaultPreferences
	rows, err := s.db.Query(ctx, "SELECT key, value FROM kv WHERE key LIKE 'pref.%'")
	if err != nil {
		return p, err
	}
	for _, r := range rows.Values {
		v := toString(r[1])
		if !hexColor.MatchString(v) {
			continue
		}
		switch toString(r[0]) {
		case "pref.upColor":
			p.UpColor = v
		case "pref.downColor":
			p.DownColor = v
		}
	}
	return p, nil
}

// SavePreferences 保存基础设置。
func (s *Store) SavePreferences(ctx context.Context, p Preferences) error {
	if !hexColor.MatchString(p.UpColor) || !hexColor.MatchString(p.DownColor) {
		return errors.New("颜色格式应为 #RRGGBB")
	}
	const up = "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
	_, err := s.db.Transaction(ctx, []sqlite.Statement{
		{SQL: up, Args: []any{"pref.upColor", strings.ToLower(p.UpColor)}},
		{SQL: up, Args: []any{"pref.downColor", strings.ToLower(p.DownColor)}},
	})
	return err
}
