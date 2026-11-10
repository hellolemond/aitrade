package main

import (
	"net/http"
	"net/url"
	"testing"
)

func TestParseScutilProxy(t *testing.T) {
	sample := []byte(`
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
  ExceptionsList : <array> {
  }
}`)
	m := parseScutilProxy(sample)
	if m["HTTPSEnable"] != "1" || m["HTTPEnable"] != "0" {
		t.Fatalf("开关解析错误：%v", m)
	}
	u := proxyURL("http", m["HTTPSProxy"], m["HTTPSPort"])
	if u == nil || u.String() != "http://127.0.0.1:7897" {
		t.Fatalf("代理 URL = %v", u)
	}
	if _, ok := m["ExceptionsList"]; ok {
		t.Fatal("不应把字典节点当成代理值")
	}
}

func TestBinanceProxySkipsLoopback(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1:9/api/v3/time",
		"http://localhost:9/api/v3/time",
		"http://[::1]:9/api/v3/time",
	} {
		req, err := http.NewRequest(http.MethodGet, raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		got, err := binanceProxy(req)
		if err != nil || got != nil {
			t.Fatalf("%s 应直连，得到 %v %v", raw, got, err)
		}
	}
}

func TestBinanceProxyUsesSystemProxy(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://api.binance.com/api/v3/time", nil)
	if err != nil {
		t.Fatal(err)
	}
	if u, err := http.ProxyFromEnvironment(req); u != nil || err != nil {
		t.Skip("当前进程已配置环境变量代理")
	}
	prev := lookupSystemProxy
	lookupSystemProxy = func(scheme string) *url.URL {
		if scheme != "https" {
			t.Fatalf("scheme = %s", scheme)
		}
		return &url.URL{Scheme: "http", Host: "127.0.0.1:7897"}
	}
	t.Cleanup(func() { lookupSystemProxy = prev })

	got, err := binanceProxy(req)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.String() != "http://127.0.0.1:7897" {
		t.Fatalf("应使用系统代理，得到 %v", got)
	}
}
