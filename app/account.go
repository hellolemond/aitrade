package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

const secretKey = "binance-api-key"

type credentials struct {
	Key    string `json:"key"`
	Secret string `json:"secret"`
}

// Permissions 是 Key 的权限检查结果。
type Permissions struct {
	Reading     bool `json:"reading"`
	SpotTrading bool `json:"spotTrading"`
	Margin      bool `json:"margin"`
	Futures     bool `json:"futures"`
	Withdrawals bool `json:"withdrawals"`
	Transfer    bool `json:"transfer"`
	Options     bool `json:"options"`
	IPRestrict  bool `json:"ipRestrict"`
	// ReadOnly 为 true 时才允许保存：除读取外，任何交易、提现、划转权限都不能开
	ReadOnly bool `json:"readOnly"`
}

type restrictions struct {
	IPRestrict                   bool `json:"ipRestrict"`
	EnableReading                bool `json:"enableReading"`
	EnableWithdrawals            bool `json:"enableWithdrawals"`
	EnableInternalTransfer       bool `json:"enableInternalTransfer"`
	EnableMargin                 bool `json:"enableMargin"`
	EnableFutures                bool `json:"enableFutures"`
	PermitsUniversalTransfer     bool `json:"permitsUniversalTransfer"`
	EnableVanillaOptions         bool `json:"enableVanillaOptions"`
	EnableSpotAndMarginTrading   bool `json:"enableSpotAndMarginTrading"`
	EnablePortfolioMarginTrading bool `json:"enablePortfolioMarginTrading"`
	EnableFixAPITrade            bool `json:"enableFixApiTrade"`
}

func (r restrictions) permissions() Permissions {
	p := Permissions{
		Reading:     r.EnableReading,
		SpotTrading: r.EnableSpotAndMarginTrading || r.EnableFixAPITrade,
		Margin:      r.EnableMargin || r.EnablePortfolioMarginTrading,
		Futures:     r.EnableFutures,
		Withdrawals: r.EnableWithdrawals,
		Transfer:    r.EnableInternalTransfer || r.PermitsUniversalTransfer,
		Options:     r.EnableVanillaOptions,
		IPRestrict:  r.IPRestrict,
	}
	p.ReadOnly = p.Reading && !p.SpotTrading && !p.Margin && !p.Futures && !p.Withdrawals && !p.Transfer && !p.Options
	return p
}

// KeyStatus 告诉页面是否已保存 Key，只给脱敏后的 API Key，Secret 永不离开 Go。
type KeyStatus struct {
	Configured bool   `json:"configured"`
	APIKey     string `json:"apiKey"`
}

// Settings 管理币安 API Key。Key 存在系统钥匙串里，不写数据库。
type Settings struct {
	ep endpoints
}

func mask(key string) string {
	if len(key) <= 12 {
		return strings.Repeat("•", len(key))
	}
	return key[:6] + "…" + key[len(key)-6:]
}

func loadCredentials() (credentials, error) {
	raw, err := mygo.Secrets.Get(secretKey)
	if err != nil {
		return credentials{}, err
	}
	var c credentials
	err = json.Unmarshal(raw, &c)
	return c, err
}

// Status 返回 Key 是否已配置。
func (s *Settings) Status() (KeyStatus, error) {
	c, err := loadCredentials()
	if errors.Is(err, mygo.ErrSecretNotFound) {
		return KeyStatus{}, nil
	}
	if err != nil {
		return KeyStatus{}, err
	}
	return KeyStatus{Configured: true, APIKey: mask(c.Key)}, nil
}

func checkPermissions(ctx context.Context, c *binanceClient) (Permissions, error) {
	var r restrictions
	if err := c.signedGet(ctx, c.ep.Spot, "/sapi/v1/account/apiRestrictions", nil, &r); err != nil {
		return Permissions{}, err
	}
	return r.permissions(), nil
}

// SaveResult 是保存 Key 的结果。权限不符时 Saved 为 false，Message 说明原因。
type SaveResult struct {
	Saved       bool        `json:"saved"`
	Message     string      `json:"message"`
	Permissions Permissions `json:"permissions"`
}

// Save 先检查权限，只有只读 Key 才写入钥匙串。
func (s *Settings) Save(ctx context.Context, apiKey, secret string) (SaveResult, error) {
	apiKey, secret = strings.TrimSpace(apiKey), strings.TrimSpace(secret)
	if apiKey == "" || secret == "" {
		return SaveResult{}, errors.New("API Key 和 Secret Key 都要填写")
	}
	p, err := checkPermissions(ctx, newBinanceClient(apiKey, secret, s.ep))
	if err != nil {
		return SaveResult{}, err
	}
	r := SaveResult{Permissions: p}
	switch {
	case !p.Reading:
		r.Message = "这个 Key 没有开启「允许读取」，未保存"
	case !p.ReadOnly:
		r.Message = "这个 Key 开启了交易、提现或划转权限，未保存。请在币安改成只读后再试"
	default:
		raw, _ := json.Marshal(credentials{Key: apiKey, Secret: secret})
		if err := mygo.Secrets.Set(secretKey, raw); err != nil {
			return r, fmt.Errorf("写入系统钥匙串失败：%w", err)
		}
		r.Saved = true
		r.Message = "已保存到系统钥匙串"
	}
	return r, nil
}

// Check 用已保存的 Key 重新检查权限（权限可能在币安后台被改过）。
func (s *Settings) Check(ctx context.Context) (Permissions, error) {
	c, err := loadCredentials()
	if err != nil {
		return Permissions{}, errors.New("尚未设置 API Key")
	}
	return checkPermissions(ctx, newBinanceClient(c.Key, c.Secret, s.ep))
}

// Delete 从钥匙串删除 Key。
func (s *Settings) Delete() error {
	return mygo.Secrets.Delete(secretKey)
}

// SpotHoldings 是现货账户里与策略有关的余额。
type SpotHoldings struct {
	USDT float64 `json:"usdt"`
	BTC  float64 `json:"btc"`
}

// CoinMHoldings 是币本位账户：BTC 余额与 BTCUSD 永续空单。
type CoinMHoldings struct {
	// WalletBTC 是钱包余额，不含未实现盈亏
	WalletBTC     float64 `json:"walletBtc"`
	UnrealizedBTC float64 `json:"unrealizedBtc"`
	// Contracts 为空单张数（正数）；出现多单时为负
	Contracts  float64 `json:"contracts"`
	Entry      float64 `json:"entry"`
	LiqPrice float64 `json:"liqPrice"`
	Leverage   int     `json:"leverage"`
	MarginType string  `json:"marginType"`
}

// USDMHoldings 是 U 本位账户：USDT 余额与 BTCUSDT 永续空单。
type USDMHoldings struct {
	WalletUSDT     float64 `json:"walletUsdt"`
	UnrealizedUSDT float64 `json:"unrealizedUsdt"`
	// ShortQty 为空单数量（BTC，正数）；出现多单时为负
	ShortQty   float64 `json:"shortQty"`
	Entry      float64 `json:"entry"`
	LiqPrice float64 `json:"liqPrice"`
	Leverage   int     `json:"leverage"`
	MarginType string  `json:"marginType"`
}

// Snapshot 是三个账户的只读快照。
type Snapshot struct {
	Time  int64         `json:"time"`
	Spot  SpotHoldings  `json:"spot"`
	CoinM CoinMHoldings `json:"coinM"`
	USDM  USDMHoldings  `json:"usdM"`
	// Warnings 是与策略约定（逐仓、1 倍、单向持仓、只做空）不符的地方
	Warnings []string `json:"warnings"`
}

type position struct {
	Symbol           string `json:"symbol"`
	PositionAmt      string `json:"positionAmt"`
	EntryPrice       string `json:"entryPrice"`
	UnRealizedProfit string `json:"unRealizedProfit"`
	LiquidationPrice string `json:"liquidationPrice"`
	Leverage         string `json:"leverage"`
	MarginType       string `json:"marginType"`
	PositionSide     string `json:"positionSide"`
	// IsolatedWallet 是逐仓保证金（仅 U 本位返回）
	IsolatedWallet string `json:"isolatedWallet"`
}

type futuresAccount struct {
	Assets []struct {
		Asset            string `json:"asset"`
		WalletBalance    string `json:"walletBalance"`
		UnrealizedProfit string `json:"unrealizedProfit"`
	} `json:"assets"`
}

func (a futuresAccount) wallet(asset string) float64 {
	for _, x := range a.Assets {
		if x.Asset == asset {
			return num(x.WalletBalance)
		}
	}
	return 0
}

// Account 读取币安持仓。
type Account struct {
	ep endpoints
}

// Snapshot 并发读取现货、币本位、U 本位三个账户。
func (a *Account) Snapshot(ctx context.Context) (Snapshot, error) {
	cred, err := loadCredentials()
	if err != nil {
		return Snapshot{}, errors.New("尚未设置 API Key")
	}
	return fetchSnapshot(ctx, newBinanceClient(cred.Key, cred.Secret, a.ep))
}

func fetchSnapshot(ctx context.Context, c *binanceClient) (Snapshot, error) {
	if err := c.syncTime(ctx); err != nil {
		return Snapshot{}, err
	}
	var (
		spot struct {
			Balances []struct {
				Asset  string `json:"asset"`
				Free   string `json:"free"`
				Locked string `json:"locked"`
			} `json:"balances"`
		}
		um, cm       futuresAccount
		umPos, cmPos []position
	)
	jobs := []struct {
		name, base, path string
		params           url.Values
		out              any
	}{
		{"现货账户", c.ep.Spot, "/api/v3/account", url.Values{"omitZeroBalances": {"true"}}, &spot},
		{"U 本位账户", c.ep.UM, "/fapi/v2/account", nil, &um},
		{"U 本位持仓", c.ep.UM, "/fapi/v2/positionRisk", url.Values{"symbol": {"BTCUSDT"}}, &umPos},
		{"币本位账户", c.ep.CM, "/dapi/v1/account", nil, &cm},
		{"币本位持仓", c.ep.CM, "/dapi/v1/positionRisk", url.Values{"pair": {"BTCUSD"}}, &cmPos},
	}
	errs := make([]error, len(jobs))
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Go(func() {
			if err := c.signedGet(ctx, j.base, j.path, j.params, j.out); err != nil {
				errs[i] = fmt.Errorf("读取%s失败：%w", j.name, err)
			}
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return Snapshot{}, err
	}

	s := Snapshot{Time: time.Now().UnixMilli(), Warnings: []string{}}
	for _, b := range spot.Balances {
		switch b.Asset {
		case "USDT":
			s.Spot.USDT = num(b.Free) + num(b.Locked)
		case "BTC":
			s.Spot.BTC = num(b.Free) + num(b.Locked)
		}
	}

	s.CoinM.WalletBTC = cm.wallet("BTC")
	for _, p := range cmPos {
		if p.Symbol != "BTCUSD_PERP" {
			continue
		}
		// 没有持仓时也检查杠杆与保证金模式，开仓前就提示，免得按错误设置下单
		s.Warnings = append(s.Warnings, settingWarnings("币本位 BTCUSD", p)...)
		s.CoinM.UnrealizedBTC += num(p.UnRealizedProfit)
		if amt := num(p.PositionAmt); amt != 0 {
			s.CoinM.Contracts -= amt
			s.CoinM.Entry = num(p.EntryPrice)
			s.CoinM.LiqPrice = num(p.LiquidationPrice)
			s.CoinM.Leverage = int(num(p.Leverage))
			s.CoinM.MarginType = p.MarginType
			if amt > 0 {
				s.Warnings = append(s.Warnings, "币本位 BTCUSD 持有多单，策略只开空单")
			}
		}
	}

	s.USDM.WalletUSDT = um.wallet("USDT")
	for _, p := range umPos {
		if p.Symbol != "BTCUSDT" {
			continue
		}
		s.Warnings = append(s.Warnings, settingWarnings("U 本位 BTCUSDT", p)...)
		s.USDM.UnrealizedUSDT += num(p.UnRealizedProfit)
		if amt := num(p.PositionAmt); amt != 0 {
			s.USDM.ShortQty -= amt
			s.USDM.Entry = num(p.EntryPrice)
			s.USDM.LiqPrice = num(p.LiquidationPrice)
			s.USDM.Leverage = int(num(p.Leverage))
			s.USDM.MarginType = p.MarginType
			s.Warnings = append(s.Warnings, usdmShortWarnings(p, amt)...)
		}
	}
	s.Warnings = dedupe(s.Warnings)
	return s, nil
}

// 强平价低于开仓价的这个倍数就提示：1 倍逐仓空单的强平价约为开仓价的 2 倍
const minLiqRatio = 1.9

// 浮亏超过逐仓保证金的这个比例就提示：回测里 1 倍空单最坏用掉约 27%
const maxLossRatio = 0.4

// settingWarnings 检查合约设置：1 倍、逐仓、单向持仓。
func settingWarnings(name string, p position) []string {
	var w []string
	if lev := int(num(p.Leverage)); lev != 1 {
		w = append(w, fmt.Sprintf("%s 杠杆为 %d 倍，应为 1 倍", name, lev))
	}
	if !strings.EqualFold(p.MarginType, "isolated") {
		w = append(w, name+" 不是逐仓模式")
	}
	if p.PositionSide != "" && p.PositionSide != "BOTH" {
		w = append(w, name+" 处于双向持仓模式，应为单向持仓")
	}
	return w
}

// usdmShortWarnings 检查 U 本位空单的风险：方向、强平距离、浮亏占保证金比例。
func usdmShortWarnings(p position, amt float64) []string {
	if amt > 0 {
		return []string{"U 本位 BTCUSDT 持有多单，策略只开空单"}
	}
	var w []string
	entry, liq := num(p.EntryPrice), num(p.LiquidationPrice)
	if entry > 0 && liq > 0 && liq/entry < minLiqRatio {
		w = append(w, fmt.Sprintf("U 本位空单强平价 %.0f 只有开仓价的 %.2f 倍（应约 2 倍），保证金不足或杠杆过高", liq, liq/entry))
	}
	if margin := num(p.IsolatedWallet); margin > 0 {
		if loss := -num(p.UnRealizedProfit) / margin; loss > maxLossRatio {
			w = append(w, fmt.Sprintf("U 本位空单浮亏已达保证金的 %.0f%%，超过 40%% 警戒线（历史最坏约 27%%），请检查", loss*100))
		}
	}
	return w
}

// dedupe 去掉重复提示并保持顺序：双向持仓模式下同一合约有 LONG、SHORT 两行，会各报一遍
func dedupe(list []string) []string {
	seen := map[string]bool{}
	out := list[:0]
	for _, x := range list {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}
