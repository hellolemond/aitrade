package main

import (
	"net/url"
	"os/exec"
	"sync"
	"time"
)

func init() {
	lookupSystemProxy = darwinSystemProxy
}

type sysProxy struct {
	http  *url.URL
	https *url.URL
	at    time.Time
}

var (
	sysMu     sync.Mutex
	sysCached sysProxy
)

func darwinSystemProxy(scheme string) *url.URL {
	p := loadDarwinProxy()
	if scheme == "http" {
		if p.http != nil {
			return p.http
		}
		return p.https
	}
	if p.https != nil {
		return p.https
	}
	return p.http
}

func loadDarwinProxy() sysProxy {
	sysMu.Lock()
	defer sysMu.Unlock()
	if !sysCached.at.IsZero() && time.Since(sysCached.at) < 30*time.Second {
		return sysCached
	}
	out, err := exec.Command("scutil", "--proxy").Output()
	if err != nil {
		sysCached = sysProxy{at: time.Now()}
		return sysCached
	}
	v := parseScutilProxy(out)
	p := sysProxy{at: time.Now()}
	if v["HTTPSEnable"] == "1" {
		p.https = proxyURL("http", v["HTTPSProxy"], v["HTTPSPort"])
	}
	if v["HTTPEnable"] == "1" {
		p.http = proxyURL("http", v["HTTPProxy"], v["HTTPPort"])
	}
	// 只有 SOCKS 时用 socks5h，让代理解析域名。本机 DNS 解析币安会得到错误地址。
	if p.https == nil && p.http == nil && v["SOCKSEnable"] == "1" {
		socks := proxyURL("socks5h", v["SOCKSProxy"], v["SOCKSPort"])
		p.http, p.https = socks, socks
	}
	sysCached = p
	return p
}
