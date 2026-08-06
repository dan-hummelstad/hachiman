package media

import "sync"

// SSRCPool tracks which uint32 SSRCs are currently in use by which sessions.
//
// PHASE 1 SIMPLIFICATION: the SSRC IS the session id. The pool exists purely
// for membership / collision bookkeeping — Get(session) returns `session`,
// Release(session) clears the entry, and SSRCForSession / SessionForSSRC are
// trivially the identity function on registered sessions. Both control and
// media must agree on this contract: control's UserState.Ssrc broadcast and
// the SFU's RTP forwarding both use the same uint32 (the Mumble session),
// otherwise receivers can't correlate audio to users.
//
// Older versions of this pool minted a fresh counter-based SSRC and returned
// it; that subtly broke `UserState.Ssrc` because control was broadcasting one
// value (the Mumble session) and media was forwarding under another (the
// counter). The CRITICAL #1 fix collapses both onto the session.
//
// The `free` slice is kept so that explicit Release-then-Get sequencing has a
// place to track recycled entries for tests / future deltas, but the SSRC
// returned by Get is always the session it was called with.
type SSRCPool struct {
	mu       sync.Mutex
	assigned map[uint32]uint32 // session -> ssrc (always equal in phase 1)
	reverse  map[uint32]uint32 // ssrc -> session (always equal in phase 1)
}

// NewSSRCPool creates a new SSRC pool.
func NewSSRCPool() *SSRCPool {
	return &SSRCPool{
		assigned: make(map[uint32]uint32),
		reverse:  make(map[uint32]uint32),
	}
}

// Get returns the SSRC for the given session. Phase 1 contract: the SSRC IS
// the session id; if the session was previously released the (session,
// session) mapping is re-installed. Calling Get(0) is permitted but reserved
// for "no SSRC" sentinel use at higher layers — the pool itself doesn't treat
// 0 specially.
func (p *SSRCPool) Get(session uint32) uint32 {
	p.mu.Lock()
	defer p.mu.Unlock()

	if ssrc, ok := p.assigned[session]; ok {
		return ssrc
	}

	p.assigned[session] = session
	p.reverse[session] = session
	return session
}

// Release returns the SSRC assigned to session back to the pool. Idempotent.
func (p *SSRCPool) Release(session uint32) {
	p.mu.Lock()
	defer p.mu.Unlock()

	ssrc, ok := p.assigned[session]
	if !ok {
		return
	}

	delete(p.assigned, session)
	delete(p.reverse, ssrc)
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
