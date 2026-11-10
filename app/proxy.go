package main

import (
	"bufio"
	"bytes"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// lookupSystemProxy 由各平台实现。环境变量里的代理优先于它。
var lookupSystemProxy = func(scheme string) *url.URL { return nil }

func newBinanceHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = binanceProxy
	return &http.Client{Timeout: 15 * time.Second, Transport: tr}
}

// binanceProxy 让币安请求走环境变量或系统代理。
// 本机直连 api.binance.com 时 DNS 会被污染，TLS 握手会一直挂到超时；
// 回环地址必须直连，否则 httptest 和本机服务会被送进代理。
func binanceProxy(req *http.Request) (*url.URL, error) {
	if req == nil || req.URL == nil || bypassProxy(req.URL.Hostname()) {
		return nil, nil
	}
	if u, err := http.ProxyFromEnvironment(req); u != nil || err != nil {
		return u, err
	}
	return lookupSystemProxy(req.URL.Scheme), nil
}

func bypassProxy(host string) bool {
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func parseScutilProxy(b []byte) map[string]string {
	m := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		k, v, ok := strings.Cut(line, " : ")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if v == "" || strings.HasPrefix(v, "<") {
			continue
		}
		m[strings.TrimSpace(k)] = v
	}
	return m
}

func proxyURL(scheme, host, port string) *url.URL {
	host = strings.TrimSpace(host)
	port = strings.TrimSpace(port)
	if host == "" || port == "" {
		return nil
	}
	return &url.URL{Scheme: scheme, Host: net.JoinHostPort(host, port)}
}
