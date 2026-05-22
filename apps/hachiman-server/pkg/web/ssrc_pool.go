package web

import "sync"

// SSRCPool allocates and recycles uint32 SSRCs for WebRTC clients.
// SSRC 0 is reserved for client-to-server audio.
// SSRCs are reused after release to keep the total count low,
// since SRTP retains crypto state per SSRC for the entire session.
type SSRCPool struct {
	mu       sync.Mutex
	next     uint32            // next SSRC to allocate (starts at 1)
	free     []uint32          // recycled SSRCs available for reuse
	assigned map[uint32]uint32 // session -> ssrc
	reverse  map[uint32]uint32 // ssrc -> session
}

// NewSSRCPool creates a new SSRC pool.
func NewSSRCPool() *SSRCPool {
	return &SSRCPool{
		next:     1,
		assigned: make(map[uint32]uint32),
		reverse:  make(map[uint32]uint32),
	}
}

// Get returns an SSRC for the given session. If the session already has an
// SSRC, it is returned. Otherwise a new one is allocated (preferring recycled
// SSRCs).
func (p *SSRCPool) Get(session uint32) uint32 {
	p.mu.Lock()
	defer p.mu.Unlock()

	if ssrc, ok := p.assigned[session]; ok {
		return ssrc
	}

	var ssrc uint32
	if len(p.free) > 0 {
		ssrc = p.free[len(p.free)-1]
		p.free = p.free[:len(p.free)-1]
	} else {
		ssrc = p.next
		p.next++
	}

	p.assigned[session] = ssrc
	p.reverse[ssrc] = session
	return ssrc
}

// Release returns the SSRC assigned to session back to the pool for reuse.
func (p *SSRCPool) Release(session uint32) {
	p.mu.Lock()
	defer p.mu.Unlock()

	ssrc, ok := p.assigned[session]
	if !ok {
		return
	}

	delete(p.assigned, session)
	delete(p.reverse, ssrc)
	p.free = append(p.free, ssrc)
}

// SSRCForSession returns the SSRC assigned to a session, if any.
func (p *SSRCPool) SSRCForSession(session uint32) (uint32, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ssrc, ok := p.assigned[session]
	return ssrc, ok
}

// SessionForSSRC returns the session that owns the given SSRC, if any.
func (p *SSRCPool) SessionForSSRC(ssrc uint32) (uint32, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	session, ok := p.reverse[ssrc]
	return session, ok
}
