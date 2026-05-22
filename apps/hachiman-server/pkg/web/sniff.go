// Copyright (c) 2026 The Grumble Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package web

import (
	"bufio"
	"errors"
	"log"
	"net"
	"sync/atomic"
	"time"
)

// channelListener is a net.Listener whose Accept() returns conns delivered
// over a channel. It lets one physical net.Listener be split into multiple
// virtual ones based on per-connection sniffing.
type channelListener struct {
	addr   net.Addr
	queue  chan net.Conn
	done   chan struct{}
	closed atomic.Bool
}

func newChannelListener(addr net.Addr) *channelListener {
	return &channelListener{
		addr:  addr,
		queue: make(chan net.Conn, 16),
		done:  make(chan struct{}),
	}
}

func (l *channelListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.queue:
		return c, nil
	case <-l.done:
		return nil, errClosedSniffListener
	}
}

func (l *channelListener) Close() error {
	if !l.closed.CompareAndSwap(false, true) {
		return errClosedSniffListener
	}
	close(l.done)
	return nil
}

func (l *channelListener) Addr() net.Addr { return l.addr }

// dispatch enqueues a conn for Accept to return. Returns false if the
// listener is closed; the caller is responsible for closing the conn then.
func (l *channelListener) dispatch(c net.Conn) bool {
	select {
	case l.queue <- c:
		return true
	case <-l.done:
		return false
	}
}

var errClosedSniffListener = errors.New("sniff listener closed")

// peekedConn replays bytes that were already buffered via Peek before
// delegating to the underlying conn for subsequent reads.
type peekedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (p *peekedConn) Read(b []byte) (int, error) {
	return p.reader.Read(b)
}

// sniffReadTimeout caps how long we'll wait for the first byte before giving
// up on a connection. Keeps slow/idle peers from tying up sniff goroutines.
const sniffReadTimeout = 5 * time.Second

// Sniff splits raw into two virtual listeners. Connections whose first byte
// is 0x16 (TLS ContentType handshake) are routed to tlsBranch; everything
// else (HTTP requests for the WebSocket upgrade) goes to wsBranch. The
// returned stop function closes the virtual branches; callers must also
// Close() raw to fully tear down the sniffer.
func Sniff(raw net.Listener, logger *log.Logger) (tlsBranch, wsBranch net.Listener, stop func()) {
	tl := newChannelListener(raw.Addr())
	wl := newChannelListener(raw.Addr())

	go func() {
		for {
			conn, err := raw.Accept()
			if err != nil {
				// Listener closed (or terminal error) — exit cleanly.
				return
			}
			go classify(conn, tl, wl, logger)
		}
	}()

	return tl, wl, func() {
		_ = tl.Close()
		_ = wl.Close()
	}
}

func classify(c net.Conn, tlsBranch, wsBranch *channelListener, logger *log.Logger) {
	_ = c.SetReadDeadline(time.Now().Add(sniffReadTimeout))
	br := bufio.NewReader(c)
	first, err := br.Peek(1)
	if err != nil {
		if logger != nil {
			logger.Printf("Sniff peek failed from %v: %v", c.RemoteAddr(), err)
		}
		_ = c.Close()
		return
	}
	_ = c.SetReadDeadline(time.Time{})

	sniffed := &peekedConn{Conn: c, reader: br}

	if first[0] == 0x16 {
		if !tlsBranch.dispatch(sniffed) {
			_ = c.Close()
		}
	} else {
		if !wsBranch.dispatch(sniffed) {
			_ = c.Close()
		}
	}
}
