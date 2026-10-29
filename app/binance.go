package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

// 币安三个账户各自的 REST 域名。测试时替换成 httptest 服务器。
type endpoints struct {
	Spot string // 现货与 sapi
	UM   string // U 本位合约
	CM   string // 币本位合约
}

var binanceEndpoints = endpoints{
	Spot: "https://api.binance.com",
	UM:   "https://fapi.binance.com",
	CM:   "https://dapi.binance.com",
}

// binanceClient 只发 GET 请求：程序里不存在任何下单、撤单、划转的调用路径，
// 即使 Key 意外带了交易权限也无法从这里下单。
type binanceClient struct {
	key, secret string
	ep          endpoints
	http        *http.Client

	mu     sync.Mutex
	offset time.Duration // 本机时钟与币安服务器的偏差
	synced bool
}

func newBinanceClient(key, secret string, ep endpoints) *binanceClient {
	return &binanceClient{key: key, secret: secret, ep: ep, http: &http.Client{Timeout: 15 * time.Second}}
}

// apiError 是币安返回的错误体，如 {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}
type apiError struct {
	Status int
	Code   int    `json:"code"`
	Msg    string `json:"msg"`
}

func (e *apiError) Error() string {
	switch e.Code {
	case -2014, -2015, -1022:
		return fmt.Sprintf("Key 无效、IP 不在白名单或缺少读取权限（%d %s）", e.Code, e.Msg)
	case -1021:
		return "本机时间与币安服务器相差过大，请校准系统时间"
	}
	if e.Msg == "" {
		return fmt.Sprintf("币安返回 HTTP %d", e.Status)
	}
	return fmt.Sprintf("币安返回错误 %d：%s", e.Code, e.Msg)
}

// syncTime 用服务器时间校正时间戳，避免本机时钟偏差导致 -1021。
func (c *binanceClient) syncTime(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.synced {
		return nil
	}
	var body struct {
		ServerTime int64 `json:"serverTime"`
	}
	start := time.Now()
	if err := c.do(ctx, c.ep.Spot+"/api/v3/time", false, &body); err != nil {
		return err
	}
	rtt := time.Since(start)
	c.offset = time.UnixMilli(body.ServerTime).Sub(start.Add(rtt / 2))
	c.synced = true
	return nil
}

// signedGet 请求一个需要签名的只读接口。
func (c *binanceClient) signedGet(ctx context.Context, base, path string, params url.Values, out any) error {
	if err := c.syncTime(ctx); err != nil {
		return err
	}
	if params == nil {
		params = url.Values{}
	}
	c.mu.Lock()
	ts := time.Now().Add(c.offset).UnixMilli()
	c.mu.Unlock()
	params.Set("timestamp", strconv.FormatInt(ts, 10))
	params.Set("recvWindow", "10000")
	query := params.Encode()
	mac := hmac.New(sha256.New, []byte(c.secret))
	mac.Write([]byte(query))
	sig := hex.EncodeToString(mac.Sum(nil))
	return c.do(ctx, base+path+"?"+query+"&signature="+sig, true, out)
}

func (c *binanceClient) do(ctx context.Context, rawURL string, auth bool, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	if auth {
		req.Header.Set("X-MBX-APIKEY", c.key)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("连接币安失败：%w", err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		e := &apiError{Status: res.StatusCode}
		_ = json.Unmarshal(data, e)
		return e
	}
	return json.Unmarshal(data, out)
}

// num 解析币安以字符串返回的数字。
func num(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}
