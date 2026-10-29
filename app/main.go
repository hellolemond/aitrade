package main

import (
	"context"
	"log"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
)

func main() {
	// 启动 10 秒后及之后每天检查一次更新；开发版不检查。
	mygo.Use(updater.Plugin)
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: "AiTrade", Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout},
			updater.MenuItem(),
			mygo.Separator(),
			{Role: mygo.RoleHide},
			{Role: mygo.RoleHideOthers},
			{Role: mygo.RoleUnhide},
			mygo.Separator(),
			{Role: mygo.RoleQuit},
		}},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleViewMenu},
		{Role: mygo.RoleWindowMenu},
	}))

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
