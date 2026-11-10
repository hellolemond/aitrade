//go:build !darwin

package main

import "net/url"

func init() {
	lookupSystemProxy = func(string) *url.URL { return nil }
}
