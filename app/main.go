package main

import (
	"context"
	"log"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

func main() {
	store := &Store{}
	mygo.Bind(store)
	mygo.Bind(&Settings{ep: binanceEndpoints})
	mygo.Bind(&Account{ep: binanceEndpoints})

	mygo.App.WhenReady(func() {
		dir, err := mygo.App.Path(mygo.PathUserData)
		if err != nil {
			log.Fatal(err)
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			log.Fatal(err)
		}
		if err := store.open(context.Background(), filepath.Join(dir, "aitrade.db")); err != nil {
			log.Fatal(err)
		}

		mygo.NewWindow(mygo.WindowOptions{
			Title:           "AiTrade · 趋势通道",
			Width:           1440,
			Height:          900,
			MinWidth:        1100,
			MinHeight:       640,
			BackgroundColor: "#fffdeb",
			StateKey:        "main",
			URL:             "/",
		})
	})
	mygo.App.OnQuit(func() {
		_ = store.close()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
