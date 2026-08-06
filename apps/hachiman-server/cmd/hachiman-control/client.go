// Copyright (c) 2010-2011 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"log"
	"net"
	"runtime"
	"sync"

	"google.golang.org/protobuf/proto"
	"mumble.info/grumble/pkg/acl"
	"mumble.info/grumble/pkg/mumbleproto"
)

// A client connection
type Client struct {
	// Logging
	*log.Logger
	lf *clientLogForwarder

	// Connection-related
	tcpaddr *net.TCPAddr
	conn    net.Conn
	reader  *bufio.Reader
	state   int
	server  *Server

	disconnected bool

	codecs []int32
	opus   bool

	// Ping stats. UdpPing* / UdpPackets are kept as legacy stats fields —
	// the native UDP voice path is gone (deleted in phase 1 step 3), but
	// the Ping wire message still carries them and older clients still
	// populate them, so we accept and echo them through `UserStats`. New
	// clients (WebRTC) should leave them zero.
	UdpPingAvg float32
	UdpPingVar float32
	UdpPackets uint32
	TcpPingAvg float32
	TcpPingVar float32
	TcpPackets uint32

	// Bandwidth Recoreder
	Bandwidth *BandwidthRecorder

	// If the client is a registered user on the server,
	// the user field will point to the registration record.
	user *User

	// The clientReady channel signals the client's reciever routine that
	// the client has been successfully authenticated and that it has been
	// sent the necessary information to be a participant on the server.
	// When this signal is received, the client has transitioned into the
	// 'ready' state.
	clientReady chan bool

	// Version
	Version    ClientVersion
	ClientName string
	OSName     string
	OSVersion  string
	CryptoMode string

	// Personal
	Username        string
	session         uint32
	certHash        string
	certVerified    bool
	Email           string
	tokens          []string
	Channel         *Channel
	SelfMute        bool
	SelfDeaf        bool
	Mute            bool
	Deaf            bool
	Suppress        bool
	PrioritySpeaker bool
	Recording       bool
	PluginContext   []byte
	PluginIdentity  string

	// RateLimit
	GlobalLimit *RateLimit
	PluginLimit *RateLimit

	// WebRTC
	// In the split-mode topology, control is the signaling shim — the actual
	// PeerConnection lives on the media node identified by mediaNodeID. The
	// SSRC was allocated by control at OpenSession time and is also embedded
	// in the voice token; control echoes it back in the user's UserState so
	// other clients can route audibility decisions. Zero values mean "no
	// WebRTC session bound" — either the client opted out, OR the OpenSession
	// envelope failed (e.g. no media node registered).
	//
	// CONCURRENCY: these fields are written from the per-client goroutine
	// (handleAuthenticate's setupWebRTCForClient call) — but ALSO from the
	// handlerLoop goroutine (via handleMediaInbound's SessionEnded handling
	// and the media-node-eviction sweeper). They're also read from
	// webrtc_handlers.go on the handler loop and from sendCloseSession on
	// the per-client disconnect path. mediaMu guards all four fields. Use
	// the helper accessors (setMediaSession / clearMediaSession / mediaNode /
	// mediaSession / mediaSSRC) wherever possible instead of touching the
	// fields directly.
	mediaMu        sync.Mutex
	webrtcEnabled  bool   // client requested WebRTC voice transport
	webrtcSSRC     uint32 // SSRC control allocated at OpenSession mint time
	mediaNodeID    string // node id of the media node terminating this session
	mediaSessionID string // string form of the session id sent to media (vServerID:Session)

	// wantsWebRTC is set by the per-client authenticate goroutine when the
	// Authenticate envelope's webrtc flag is true. The actual
	// setupWebRTCForClient call is deferred to finishAuthenticate (which
	// runs on the handlerLoop) so OpenSession is sent AFTER the client is
	// in server.clients — closing CRITICAL #2.
	wantsWebRTC bool

	// Oracle / Takusen SSO
	// Populated only after a successful RFC 7662 introspection in
	// handleAuthenticate. OracleVerified is the single source of truth
	// for whether the client should be treated as Oracle-authenticated;
	// the handle/sub fields are informational and may be empty even when
	// verified is true (e.g. AS omits preferred_username).
	OracleSub      string
	OracleHandle   string
	OracleVerified bool

	// superUser is set when the client has been granted SuperUser-equivalent
	// privileges OUT-OF-BAND from the registered-user system — currently only
	// via the Oracle owner-grant in handleAuthenticate (when the introspected
	// `sub` matches the vServer's AdminOracleUserID config). Keeping this as
	// a side-channel flag lets us preserve the client's real `user` record
	// (so display name + finishAuthenticate's UserId-based dedup keep working
	// for registered users) while still passing IsSuperUser() and the
	// acl.HasPermission UserId()==0 short-circuit for anonymous Oracle admins.
	// The legacy local-password SuperUser path (UserGetAuth → user.Id==0)
	// continues to work unchanged via the second arm of IsSuperUser().
	superUser bool
}

// Debugf implements debug-level printing for Clients.
func (client *Client) Debugf(format string, v ...interface{}) {
	client.Printf(format, v...)
}

// IsRegistered Is the client a registered user?
func (client *Client) IsRegistered() bool {
	return client.user != nil
}

// HasCertificate Does the client have a certificate?
func (client *Client) HasCertificate() bool {
	return len(client.certHash) > 0
}

// IsCertificateValid Is the client has a verified certificate?
func (client *Client) IsCertificateVerified() bool {
	return client.certVerified
}

// IsSuperUser Is the client the SuperUser?
//
// True if either (a) the client logged in as the local "SuperUser" account
// (user.Id == 0, the original Murmur path) OR (b) the client was granted
// SuperUser out-of-band via the Oracle owner-grant in handleAuthenticate.
func (client *Client) IsSuperUser() bool {
	if client.superUser {
		return true
	}
	if client.user == nil {
		return false
	}
	return client.user.Id == 0
}

func (client *Client) ACLContext() *acl.Context {
	return &client.Channel.ACL
}

func (client *Client) CertHash() string {
	return client.certHash
}

func (client *Client) Session() uint32 {
	return client.session
}

func (client *Client) Tokens() []string {
	return client.tokens
}

// UserId gets the User ID of this client.
// Returns -1 if the client is not a registered user.
//
// Anonymous Oracle admins (granted via the Oracle owner-grant — see
// IsSuperUser comment) report UserId == 0 so the acl.HasPermission
// UserId() == 0 short-circuit grants them the same blanket privileges the
// local "SuperUser" account gets. Registered users who are also Oracle
// admins keep their real UserId (so finishAuthenticate's per-UserId dedup
// can't collapse two distinct registered identities into one).
func (client *Client) UserId() int {
	if client.user == nil {
		if client.superUser {
			return 0
		}
		return -1
	}
	return int(client.user.Id)
}

// ShownName gets the client's shown name.
//
// Precedence for SuperUsers:
//   - Oracle-granted admins (managed-mode owner via AdminOracleUserID) surface
//     their actual Oracle identity — OracleHandle (preferred_username from
//     introspection) when present, otherwise the username they sent in
//     Authenticate. The legacy "SuperUser" literal is wrong here: the only
//     identity Grumble persists for an Oracle user is the sub (UUID), and
//     the display name is live data from each introspection — collapsing it
//     to "SuperUser" both lies to other clients in the member list and
//     defeats the cross-client identity guarantee.
//   - Local-password SuperUsers (the legacy self-host UserId=0 path) keep
//     the "SuperUser" literal — that account literally has no other name.
func (client *Client) ShownName() string {
	if client.IsSuperUser() {
		if client.OracleVerified {
			if client.OracleHandle != "" {
				return client.OracleHandle
			}
			return client.Username
		}
		return "SuperUser"
	}
	if client.IsRegistered() {
		return client.user.Name
	}
	return client.Username
}

// IsVerified checks whether the client's certificate is
// verified.
func (client *Client) IsVerified() bool {
	tlsconn := client.conn.(*tls.Conn)
	state := tlsconn.ConnectionState()
	return len(state.VerifiedChains) > 0
}

// Log a panic and disconnect the client.
func (client *Client) Panic(v ...interface{}) {
	client.Print(v...)
	client.Disconnect()
}

// Log a formatted panic and disconnect the client.
func (client *Client) Panicf(format string, v ...interface{}) {
	client.Printf(format, v...)
	client.Disconnect()
}

// Internal disconnect function
func (client *Client) disconnect(kicked bool) {
	if !client.disconnected {
		client.disconnected = true
		client.server.RemoveClient(client, kicked)

		// If the client paniced during authentication, before reaching
		// the ready state, the receiver goroutine will be waiting for
		// a signal telling it that the client is ready to receive 'real'
		// messages from the server.
		//
		// In case of a premature disconnect, close the channel so the
		// receiver routine can exit correctly.
		if client.state == StateClientSentVersion || client.state == StateClientAuthenticated {
			close(client.clientReady)
		}

		client.Printf("Disconnected")
		client.conn.Close()

		client.server.updateCodecVersions(nil)
	}
}

// Disconnect a client (client requested or server shutdown)
func (client *Client) Disconnect() {
	client.disconnect(false)
}

// Disconnect a client (kick/ban)
func (client *Client) ForceDisconnect() {
	client.disconnect(true)
}

// ClearCaches is a no-op now that voice-target whisper caches retire with
// the native UDP path (phase 1 step 3). Subscription matrix changes go over
// the control↔media sidechannel (`SubscriptionMatrixUpdate`); no client-side
// cache to invalidate here. Kept as a method so existing call sites compile;
// drop the call sites in a follow-up sweep.
func (client *Client) ClearCaches() {}

// Reject an authentication attempt
func (client *Client) RejectAuth(rejectType mumbleproto.Reject_RejectType, reason string) {
	var reasonString *string = nil
	if len(reason) > 0 {
		reasonString = proto.String(reason)
	}

	client.sendMessage(&mumbleproto.Reject{
		Type:   rejectType.Enum(),
		Reason: reasonString,
	})

	client.ForceDisconnect()
}

// Read a protobuf message from a client
func (client *Client) readProtoMessage() (msg *Message, err error) {
	var (
		length uint32
		kind   uint16
	)

	// Read the message type (16-bit big-endian unsigned integer)
	err = binary.Read(client.reader, binary.BigEndian, &kind)
	if err != nil {
		return
	}

	// Read the message length (32-bit big-endian unsigned integer)
	err = binary.Read(client.reader, binary.BigEndian, &length)
	if err != nil {
		return
	}

	buf := make([]byte, length)
	_, err = io.ReadFull(client.reader, buf)
	if err != nil {
		return
	}

	msg = &Message{
		buf:    buf,
		kind:   kind,
		client: client,
	}

	return
}

// Send permission denied by type
func (c *Client) sendPermissionDeniedType(denyType mumbleproto.PermissionDenied_DenyType) {
	c.sendPermissionDeniedTypeUser(denyType, nil)
}

// Send permission denied by type (and user)
func (c *Client) sendPermissionDeniedTypeUser(denyType mumbleproto.PermissionDenied_DenyType, user *Client) {
	pd := &mumbleproto.PermissionDenied{
		Type: denyType.Enum(),
	}
	if user != nil {
		pd.Session = proto.Uint32(uint32(user.Session()))
	}
	err := c.sendMessage(pd)
	if err != nil {
		c.Panicf("%v", err.Error())
		return
	}
}

// Send permission denied by who, what, where
func (c *Client) sendPermissionDenied(who *Client, where *Channel, what acl.Permission) {
	pd := &mumbleproto.PermissionDenied{
		Permission: proto.Uint32(uint32(what)),
		ChannelId:  proto.Uint32(uint32(where.Id)),
		Session:    proto.Uint32(who.Session()),
		Type:       mumbleproto.PermissionDenied_Permission.Enum(),
	}
	err := c.sendMessage(pd)
	if err != nil {
		c.Panicf("%v", err.Error())
		return
	}
}

// Send permission denied fallback
func (client *Client) sendPermissionDeniedFallback(denyType mumbleproto.PermissionDenied_DenyType, version ClientVersion, text string) {
	pd := &mumbleproto.PermissionDenied{
		Type: denyType.Enum(),
	}
	if client.Version < version {
		pd.Reason = proto.String(text)
	}
	err := client.sendMessage(pd)
	if err != nil {
		client.Panicf("%v", err.Error())
		return
	}
}

// Send a Message to the client.  The Message in msg to the client's
// buffered writer and flushes it when done.
//
// This method should only be called from within the client's own
// sender goroutine, since it serializes access to the underlying
// buffered writer.
func (client *Client) sendMessage(msg interface{}) error {
	buf := new(bytes.Buffer)
	var (
		kind    uint16
		msgData []byte
		err     error
	)

	kind = mumbleproto.MessageType(msg)
	protoMsg, ok := (msg).(proto.Message)
	if !ok {
		return errors.New("client: expected a proto.Message")
	}
	msgData, err = proto.Marshal(protoMsg)
	if err != nil {
		return err
	}

	err = binary.Write(buf, binary.BigEndian, kind)
	if err != nil {
		return err
	}
	err = binary.Write(buf, binary.BigEndian, uint32(len(msgData)))
	if err != nil {
		return err
	}
	_, err = buf.Write(msgData)
	if err != nil {
		return err
	}

	_, err = client.conn.Write(buf.Bytes())
	if err != nil {
		return err
	}

	return nil
}

// TLS receive loop
func (client *Client) tlsRecvLoop() {
	for {
		// The version handshake is done, the client has been authenticated and it has received
		// all necessary information regarding the server.  Now we're ready to roll!
		if client.state == StateClientReady {
			// Try to read the next message in the pool
			msg, err := client.readProtoMessage()
			if err != nil {
				if err == io.EOF {
					client.Disconnect()
				} else {
					client.Panicf("%v", err)
				}
				return
			}
			client.Bandwidth.ResetIdleSeconds()
			client.server.incoming <- msg
		}

		// The client has responded to our version query. It will try to authenticate.
		if client.state == StateClientSentVersion {
			// Try to read the next message in the pool
			msg, err := client.readProtoMessage()
			if err != nil {
				if err == io.EOF {
					client.Disconnect()
				} else {
					client.Panicf("%v", err)
				}
				return
			}

			client.clientReady = make(chan bool)
			go client.server.handleAuthenticate(client, msg)
			<-client.clientReady

			// It's possible that the client has disconnected in the meantime.
			// In that case, step out of the receiver, since there's nothing left
			// to receive.
			if client.disconnected {
				return
			}

			close(client.clientReady)
			client.clientReady = nil
		}

		// The client has just connected. Before it sends its authentication
		// information we must send it our version information so it knows
		// what version of the protocol it should speak.
		if client.state == StateClientConnected {
			// CryptoModes was the OCB nonce-resync negotiation hint for the
			// deleted native Mumble UDP voice path (phase 1 step 3). WebRTC's
			// DTLS-SRTP terminates encryption, so this field is intentionally
			// left empty — old clients see "server offers no modes" and skip
			// the legacy CryptSetup dance entirely.
			version := &mumbleproto.Version{
				VersionV1: proto.Uint32(client.server.Version.VersionV1()),
				VersionV2: proto.Uint64(client.server.Version.VersionV2()),
				Release:   proto.String("Hachiman"),
			}
			if client.server.cfg.BoolValue("SendOSInfo") {
				version.Os = proto.String(runtime.GOOS)
				version.OsVersion = proto.String("(Unknown version)")
			}
			client.sendMessage(version)
			client.state = StateServerSentVersion
			continue
		} else if client.state == StateServerSentVersion {
			msg, err := client.readProtoMessage()
			if err != nil {
				if err == io.EOF {
					client.Disconnect()
				} else {
					client.Panicf("%v", err)
				}
				return
			}

			client.server.handleVersionMessage(client, msg)
			client.state = StateClientSentVersion
		}
	}
}

// setMediaSession records the freshly-opened media session against this
// client. Holds mediaMu briefly. SSRC may be 0 to mean "media hasn't
// echoed the assigned SSRC yet"; the SessionEstablished envelope path
// fills it in once media confirms.
func (client *Client) setMediaSession(nodeID, sessionID string, ssrc uint32) {
	client.mediaMu.Lock()
	defer client.mediaMu.Unlock()
	client.webrtcEnabled = true
	client.webrtcSSRC = ssrc
	client.mediaNodeID = nodeID
	client.mediaSessionID = sessionID
}

// setMediaSSRC updates only the SSRC field — used by the SessionEstablished
// dispatch path once media has confirmed the SSRC it actually assigned.
func (client *Client) setMediaSSRC(ssrc uint32) {
	client.mediaMu.Lock()
	defer client.mediaMu.Unlock()
	client.webrtcSSRC = ssrc
}

// clearMediaSession resets every WebRTC/media field. Called on rollback
// (OpenSession dispatch failed) and on SessionEnded.
func (client *Client) clearMediaSession() {
	client.mediaMu.Lock()
	defer client.mediaMu.Unlock()
	client.webrtcEnabled = false
	client.webrtcSSRC = 0
	client.mediaNodeID = ""
	client.mediaSessionID = ""
}

// mediaState returns a snapshot of all four media-session fields under
// mediaMu. Callers that just need a single field should use the
// purpose-specific accessor below.
func (client *Client) mediaState() (enabled bool, ssrc uint32, nodeID, sessionID string) {
	client.mediaMu.Lock()
	defer client.mediaMu.Unlock()
	return client.webrtcEnabled, client.webrtcSSRC, client.mediaNodeID, client.mediaSessionID
}

// mediaNode returns the media node id assigned to this client, or "" if
// none. Acquires mediaMu.
func (client *Client) mediaNode() string {
	client.mediaMu.Lock()
	defer client.mediaMu.Unlock()
	return client.mediaNodeID
}

// mediaSession returns the media-side session id assigned to this client,
// or "" if none. Acquires mediaMu.
func (client *Client) mediaSession() string {
	client.mediaMu.Lock()
	defer client.mediaMu.Unlock()
	return client.mediaSessionID
}

// mediaSSRC returns the SSRC echoed back by media (or 0 if SessionEstablished
// hasn't landed yet). Acquires mediaMu.
func (client *Client) mediaSSRC() uint32 {
	client.mediaMu.Lock()
	defer client.mediaMu.Unlock()
	return client.webrtcSSRC
}

// isWebRTCEnabled reports whether the client has a live media session
// bound. Acquires mediaMu.
func (client *Client) isWebRTCEnabled() bool {
	client.mediaMu.Lock()
	defer client.mediaMu.Unlock()
	return client.webrtcEnabled
}

func (client *Client) sendChannelList() {
	client.sendChannelTree(client.server.RootChannel())
}

func (client *Client) sendChannelTree(channel *Channel) {
	chanstate := &mumbleproto.ChannelState{
		ChannelId:   proto.Uint32(uint32(channel.Id)),
		Name:        proto.String(channel.Name),
		ChannelType: channel.Type.Enum(),
	}
	if channel.parent != nil {
		chanstate.Parent = proto.Uint32(uint32(channel.parent.Id))
	}

	if channel.HasDescription() {
		if client.Version.SupportDescBlobHash() {
			chanstate.DescriptionHash = channel.DescriptionBlobHashBytes()
		} else {
			buf, err := blobStore.Get(channel.DescriptionBlob)
			if err != nil {
				panic("Blobstore error.")
			}
			chanstate.Description = proto.String(string(buf))
		}
	}

	if channel.IsTemporary() {
		chanstate.Temporary = proto.Bool(true)
	}

	chanstate.Position = proto.Int32(int32(channel.Position))

	links := []uint32{}
	for cid := range channel.Links {
		links = append(links, uint32(cid))
	}
	chanstate.Links = links

	err := client.sendMessage(chanstate)
	if err != nil {
		client.Panicf("%v", err)
	}

	for _, subchannel := range channel.children {
		client.sendChannelTree(subchannel)
	}
}
