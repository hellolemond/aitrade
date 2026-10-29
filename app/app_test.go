package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := openStore(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.close() })
	return s
}

func TestWatchlistDefaultAndSave(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	list, err := s.Watchlist(ctx)
	if err != nil || len(list) != 1 || list[0] != "BTCUSDT" {
		t.Fatalf("默认自选 = %v, %v", list, err)
	}
	if err := s.SetWatchlist(ctx, []string{"BTCUSDT", "ethusdt", "BTCUSDT"}); err != nil {
		t.Fatal(err)
	}
	list, _ = s.Watchlist(ctx)
	if strings.Join(list, ",") != "BTCUSDT,ETHUSDT" {
		t.Fatalf("自选 = %v", list)
	}
	if err := s.SetWatchlist(ctx, nil); err == nil {
		t.Fatal("空列表应报错")
	}
}

func TestTaskLifecycle(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)

	if st, _ := s.StrategyState(ctx); st != nil {
		t.Fatalf("初始进度应为空，得到 %+v", st)
	}
	first, err := s.CreateTask(ctx, NewTask{
		Kind: "flip", Title: "转空", CandleTime: 100, Close: 80105,
		Steps: []NewStep{{Account: "币本位", Text: "开空 28 张"}, {Account: "U本位", Text: "开空 0.014 BTC"}},
	}, StrategyState{State: 0, LastCandleTime: 100, LastRebalanceYear: 2026})
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "pending" || len(first.Steps) != 2 || first.Steps[1].Text != "开空 0.014 BTC" {
		t.Fatalf("新记录 = %+v", first)
	}
	st, _ := s.StrategyState(ctx)
	if st == nil || st.State != 0 || st.LastCandleTime != 100 || st.LastRebalanceYear != 2026 {
		t.Fatalf("进度 = %+v", st)
	}

	got, _ := s.MarkStep(ctx, first.Steps[0].ID, true)
	if got.Status != "pending" || got.Steps[0].DoneAt == 0 {
		t.Fatalf("标记一步后 = %+v", got)
	}
	got, _ = s.MarkStep(ctx, first.Steps[1].ID, true)
	if got.Status != "done" || got.DoneAt == 0 {
		t.Fatalf("全部标记后应完成：%+v", got)
	}
	got, _ = s.MarkStep(ctx, first.Steps[1].ID, false)
	if got.Status != "pending" || got.DoneAt != 0 {
		t.Fatalf("撤销后应回到待操作：%+v", got)
	}

	// 新信号取代未完成的旧记录
	second, err := s.CreateTask(ctx, NewTask{
		Kind: "flip", Title: "转多", CandleTime: 200, Close: 90000, Supersede: true,
		Steps: []NewStep{{Account: "币本位", Text: "平空 28 张"}},
	}, StrategyState{State: 1, LastCandleTime: 200, LastRebalanceYear: 2026})
	if err != nil {
		t.Fatal(err)
	}
	if second.Steps[0].Text != "平空 28 张" {
		t.Fatalf("步骤挂错记录：%+v", second)
	}
	pending, _ := s.Tasks(ctx, "pending", 0)
	if len(pending) != 1 || pending[0].ID != second.ID {
		t.Fatalf("待操作 = %+v", pending)
	}
	done, _ := s.Tasks(ctx, "done", 0)
	if len(done) != 1 || done[0].Status != "superseded" {
		t.Fatalf("旧记录应被取代：%+v", done)
	}
	// 被取代的记录再勾选也不会复活
	if got, _ := s.MarkStep(ctx, first.Steps[1].ID, true); got.Status != "superseded" {
		t.Fatalf("被取代记录状态 = %s", got.Status)
	}

	got, _ = s.MarkTask(ctx, second.ID)
	if got.Status != "done" || got.Steps[0].DoneAt == 0 {
		t.Fatalf("整条标记 = %+v", got)
	}

	// 没有步骤的记录（例如偏差小于 1% 的再平衡）直接完成
	empty, _ := s.CreateTask(ctx, NewTask{Kind: "rebalance", Title: "2027 再平衡"}, StrategyState{State: 1, LastCandleTime: 300, LastRebalanceYear: 2027})
	if empty.Status != "done" {
		t.Fatalf("无步骤记录 = %+v", empty)
	}
}

func TestRestrictions(t *testing.T) {
	ro := restrictions{EnableReading: true, IPRestrict: true}.permissions()
	if !ro.ReadOnly {
		t.Fatal("只读 Key 应通过")
	}
	for _, r := range []restrictions{
		{EnableReading: true, EnableSpotAndMarginTrading: true},
		{EnableReading: true, EnableFutures: true},
		{EnableReading: true, EnableWithdrawals: true},
		{EnableReading: true, PermitsUniversalTransfer: true},
		{EnableReading: true, EnableInternalTransfer: true},
		{EnableReading: false},
	} {
		if r.permissions().ReadOnly {
			t.Fatalf("%+v 不应视为只读", r)
		}
	}
}

func TestSnapshot(t *testing.T) {
	var sawPost bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			sawPost = true
		}
		if r.URL.Path != "/api/v3/time" {
			if r.Header.Get("X-MBX-APIKEY") != "k" || r.URL.Query().Get("signature") == "" {
				w.WriteHeader(401)
				w.Write([]byte(`{"code":-2015,"msg":"Invalid API-key"}`))
				return
			}
		}
		var body any
		switch r.URL.Path {
		case "/api/v3/time":
			body = map[string]any{"serverTime": 1_793_145_600_000}
		case "/api/v3/account":
			body = map[string]any{"balances": []map[string]string{
				{"asset": "USDT", "free": "2800.5", "locked": "0"},
				{"asset": "BTC", "free": "0.001", "locked": "0"},
				{"asset": "ETH", "free": "1", "locked": "0"},
			}}
		case "/fapi/v2/account":
			body = map[string]any{"assets": []map[string]string{{"asset": "USDT", "walletBalance": "1199.4", "unrealizedProfit": "22.5"}}}
		case "/fapi/v2/positionRisk":
			body = []map[string]string{{"symbol": "BTCUSDT", "positionAmt": "-0.015", "entryPrice": "81343.5", "unRealizedProfit": "22.5",
				"liquidationPrice": "161200", "leverage": "1", "marginType": "isolated", "positionSide": "BOTH"}}
		case "/dapi/v1/account":
			body = map[string]any{"assets": []map[string]string{{"asset": "BTC", "walletBalance": "0.035", "unrealizedProfit": "0"}}}
		case "/dapi/v1/positionRisk":
			body = []map[string]string{{"symbol": "BTCUSD_PERP", "positionAmt": "-28", "entryPrice": "80105", "unRealizedProfit": "0.0001",
				"liquidationPrice": "0", "leverage": "3", "marginType": "cross", "positionSide": "BOTH"}}
		default:
			w.WriteHeader(404)
			return
		}
		json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()

	c := newBinanceClient("k", "s", endpoints{Spot: srv.URL, UM: srv.URL, CM: srv.URL})
	s, err := fetchSnapshot(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if sawPost {
		t.Fatal("只允许 GET 请求")
	}
	if s.Spot.USDT != 2800.5 || s.Spot.BTC != 0.001 {
		t.Fatalf("现货 = %+v", s.Spot)
	}
	if s.USDM.ShortQty != 0.015 || s.USDM.WalletUSDT != 1199.4 || s.USDM.Entry != 81343.5 {
		t.Fatalf("U 本位 = %+v", s.USDM)
	}
	if s.CoinM.Contracts != 28 || s.CoinM.WalletBTC != 0.035 || s.CoinM.UnrealizedBTC != 0.0001 {
		t.Fatalf("币本位 = %+v", s.CoinM)
	}
	if len(s.Warnings) != 2 || !strings.Contains(s.Warnings[0], "3 倍") || !strings.Contains(s.Warnings[1], "逐仓") {
		t.Fatalf("应提示币本位杠杆与全仓：%v", s.Warnings)
	}

	bad := newBinanceClient("wrong", "s", endpoints{Spot: srv.URL, UM: srv.URL, CM: srv.URL})
	if _, err := fetchSnapshot(context.Background(), bad); err == nil || !strings.Contains(err.Error(), "Key 无效") {
		t.Fatalf("错误 Key 应报错：%v", err)
	}
}

func TestPositionWarnings(t *testing.T) {
	ok := position{Leverage: "1", MarginType: "isolated", PositionSide: "BOTH"}
	if w := settingWarnings("U", ok); len(w) != 0 {
		t.Fatalf("正确设置不应提示：%v", w)
	}
	if w := settingWarnings("U", position{Leverage: "5", MarginType: "cross", PositionSide: "SHORT"}); len(w) != 3 {
		t.Fatalf("杠杆、全仓、双向都应提示：%v", w)
	}
	safe := position{EntryPrice: "80000", LiquidationPrice: "158000", UnRealizedProfit: "-50", IsolatedWallet: "600"}
	if w := usdmShortWarnings(safe, -0.007); len(w) != 0 {
		t.Fatalf("1 倍空单不应提示：%v", w)
	}
	risky := position{EntryPrice: "80000", LiquidationPrice: "120000", UnRealizedProfit: "-300", IsolatedWallet: "600"}
	if w := usdmShortWarnings(risky, -0.007); len(w) != 2 {
		t.Fatalf("强平过近与浮亏过大都应提示：%v", w)
	}
	if w := usdmShortWarnings(ok, 0.01); len(w) != 1 || !strings.Contains(w[0], "多单") {
		t.Fatalf("多单应提示：%v", w)
	}
	if got := dedupe([]string{"a", "b", "a", "c", "b"}); strings.Join(got, "") != "abc" {
		t.Fatalf("去重 = %v", got)
	}
}

func TestPreferences(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	p, err := s.Preferences(ctx)
	if err != nil || p != DefaultPreferences {
		t.Fatalf("默认设置 = %+v, %v", p, err)
	}
	if err := s.SavePreferences(ctx, Preferences{UpColor: "#2962FF", DownColor: "#ff9800"}); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Preferences(ctx); p.UpColor != "#2962ff" || p.DownColor != "#ff9800" {
		t.Fatalf("保存后 = %+v", p)
	}
	if err := s.SavePreferences(ctx, Preferences{UpColor: "red", DownColor: "#000000"}); err == nil {
		t.Fatal("非法颜色应报错")
	}
}
