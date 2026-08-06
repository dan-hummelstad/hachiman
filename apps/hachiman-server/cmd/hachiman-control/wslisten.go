// Copyright (c) 2018 The Grumble Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	HandshakeTimeout: 20 * time.Second,
	Subprotocols:     []string{"mumble", "binary"},
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// wsListener is the WebSocket "listener" half of the TCP+WSS port multiplexer.
// It's plumbed in via Sniff (wssniff.go) on connections that aren't TLS; the
// HTTP server upgrades them to WebSocket here and delivers wrapped net.Conns
// back to Accept. The type was previously exported as media.Listener — it has
// no reason to live in pkg/media now that the SFU has moved to hachiman-media,
// so it lives next to server.go as a control-plane internal.
type wsListener struct {
	sockets chan *conn
	done    chan struct{}
	addr    net.Addr
	closed  int32
	logger  *log.Logger
}

func newWSListener(laddr net.Addr, logger *log.Logger) *wsListener {
	return &wsListener{
		sockets: make(chan *conn),
		done:    make(chan struct{}),
		addr:    laddr,
		logger:  logger,
	}
}

func (l *wsListener) Accept() (net.Conn, error) {
	if atomic.LoadInt32(&l.closed) != 0 {
		return nil, fmt.Errorf("accept ws %v: use of closed websocket listener", l.addr)
	}
	select {
	case ws := <-l.sockets:
		return ws, nil
	case <-l.done:
		return nil, fmt.Errorf("accept ws %v: use of closed websocket listener", l.addr)
	}
}

func (l *wsListener) Close() error {
	if !atomic.CompareAndSwapInt32(&l.closed, 0, 1) {
		return fmt.Errorf("close ws %v: use of closed websocket listener", l.addr)
	}
	close(l.done)
	return nil
}

func (l *wsListener) Addr() net.Addr {
	return l.addr
}

func (l *wsListener) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if atomic.LoadInt32(&l.closed) != 0 {
		http.Error(w, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		return
	}
	l.logger.Printf("Upgrading web connection from: %v", r.RemoteAddr)
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		l.logger.Printf("Failed upgrade: %v", err)
		return
	}
	l.sockets <- &conn{ws: ws}
}
