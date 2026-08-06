// Copyright (c) 2010-2011 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha512"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/pbkdf2"
	"google.golang.org/protobuf/proto"
	"mumble.info/grumble/pkg/acl"
	"mumble.info/grumble/pkg/ban"
	"mumble.info/grumble/pkg/database"
	"mumble.info/grumble/pkg/htmlfilter"
	"mumble.info/grumble/pkg/logtarget"
	"mumble.info/grumble/pkg/mumbleproto"
	"mumble.info/grumble/pkg/serverconf"
	"mumble.info/grumble/pkg/sessionpool"
)

// The default port a Murmur server listens on
const DefaultPort = 64738
const DefaultWebPort = 443

const LogOpsBeforeSync = 100
const CeltCompatBitstream = -2147483637
const (
	StateClientConnected = iota
	StateServerSentVersion
	StateClientSentVersion
	StateClientAuthenticated
	StateClientReady
	StateClientDead
)

type KeyValuePair struct {
	Key   string
	Value string
	Reset bool
}

// A Murmur server instance
type Server struct {
	Id int64

	tcpl      *net.TCPListener
	tlsl      net.Listener
	tlscfg    *tls.Config
	webwsl    *wsListener
	webtlscfg *tls.Config
	webhttp   *http.Server
	sniffStop func()
	bye       chan bool
	// stopCh is closed in Stop() to wake any per-server goroutines that
	// don't go through the bye/netwg path (e.g. the deferred registration
	// timer). Allocated alongside bye in initPerLaunchData.
	stopCh  chan struct{}
	netwg   sync.WaitGroup
	running bool

	incoming   chan *Message
	tempRemove chan *Channel

	// mediaInbound carries envelopes from media's sidechannel into the
	// handler goroutine so that translating them into per-client wire
	// effects happens on the same goroutine that owns server.clients. The
	// sidechannel stream is fan-out: one stream per node, many vServers.
	// Routing across vServers happens in ServerRegistry; once a Client +
	// Server have been resolved, the envelope lands here and the actual
	// `client.sendMessage` calls run inside handlerLoop just like
	// TCP-driven flows.
	//
	// MEDIUM #3: held in an atomic.Pointer so the lifecycle
	// init/cleanPerLaunchData paths can swap the value without racing
	// concurrent reads from the sidechannel goroutine.
	mediaInbound atomic.Pointer[chan mediaInboundJob]

	// mediaInboundDropped counts envelopes the dispatcher had to drop
	// because mediaInbound was full. HIGH #1: the drop semantics are
	// intentional (one stalled vServer must NOT wedge the sidechannel for
	// the whole fleet) but they need to be visible. Updated atomically by
	// ServerRegistry.HandleMediaInbound; read by Stop() / ops introspection.
	mediaInboundDropped uint64

	// pendingReclaim tracks Mumble session numbers that have been
	// CloseSession'd but not yet confirmed via SessionEnded. The
	// sessionpool.Reclaim is deferred until SessionEnded so a fresh client
	// can't be issued the same session number while media is still tearing
	// down the previous SFU peer (HIGH #4). The sweeper forcibly reclaims
	// entries older than pendingReclaimTimeout as a safety net for
	// partition cases. Touched only on handlerLoop, no lock needed.
	pendingReclaim map[uint32]time.Time

	// Signals to the server that a client has been successfully
	// authenticated.
	clientAuthenticated chan *Client

	// Server configuration
	cfg serverconf.ConfigRepo

	// Clients
	clients map[uint32]*Client

	// Codec information
	AlphaCodec       int32
	BetaCodec        int32
	PreferAlphaCodec bool
	Opus             bool

	// Database
	DB *database.GrumbleDb

	// Channels
	Channels       map[int]*Channel
	nextTempChanID int

	// Users
	Users map[uint32]*User

	// Sessions
	pool *sessionpool.SessionPool

	// Bans
	banlock sync.RWMutex
	Bans    []ban.Ban

	// Logging
	*log.Logger

	listenerManager ChannelListenerManager

	// Other configurations
	DataDir string
	Version ClientVersion

	// registry is a back-pointer to the in-process vServer registry. Phase 1
	// final pass uses it to reach the MediaControl sidechannel listener so
	// per-client WebRTC handlers can pick a media node and push OpenSession /
	// SdpSignal envelopes. Nil pre-registration (set by ServerRegistry.Register).
	registry *ServerRegistry
}

type clientLogForwarder struct {
	client *Client
	logger *log.Logger
}

func (lf clientLogForwarder) Write(incoming []byte) (int, error) {
	buf := new(bytes.Buffer)
	buf.WriteString(fmt.Sprintf("<%v:%v(%v)> ", lf.client.Session(), lf.client.ShownName(), lf.client.UserId()))
	buf.Write(incoming)
	lf.logger.Output(3, buf.String())
	return len(incoming), nil
}

// Allocate a new Murmur instance
func NewServer(id int64, dataDir string, db *database.GrumbleDb) (s *Server, err error) {
	s = new(Server)

	s.Id = id
	s.DB = db

	s.cfg = NewConfigWrapper(db, uint64(id))
	s.DataDir = dataDir
	s.Version = VersionFromComponent(1, 5, 0)
	s.nextTempChanID = 10000000 // use a high channel id for identity

	s.Channels = make(map[int]*Channel)
	s.Users = make(map[uint32]*User)
	s.Logger = log.New(logtarget.Default, fmt.Sprintf("[%v] ", s.Id), log.LstdFlags|log.Lmicroseconds)

	// Generate random password for superuser
	randomBytes := make([]byte, 9)
	rand.Read(randomBytes)
	rootPassword := base64.StdEncoding.EncodeToString(randomBytes)

	// Create root account, channel, groups, and seed the default per-vServer
	// ACL rows. ServerInit is idempotent across all of (SuperUser, root
	// channel, admin group, admin GroupMember) and seedRootChannelACLs is
	// idempotent across the ACL UPSERTs, so re-running NewServer on an
	// existing vServer is a safe no-op. Errors propagate out of the tx so
	// gorm rolls back the whole bundle on partial failure — we then log
	// the failure rather than swallow it (the previous behaviour left
	// half-initialised servers that Fatalf'd on first client connect; the
	// defense-in-depth in RootChannel() below now catches that, but we
	// still surface the cause loudly here).
	// Managed vServers (provisioned via the gRPC CreateVirtualServer flow)
	// are detected by the AdminOracleUserID config key, which the management
	// service stamps in the SAME tx as ServerAdd BEFORE this NewServer call
	// runs. Self-host vServers leave it empty (DefaultCfg) and get the
	// classic SuperUser-row bootstrap. See pkg/database/server.go ServerInit
	// for the managed-mode contract (no SuperUser row, no admin GroupMember;
	// the Oracle owner-grant in handleAuthenticate replaces both).
	isManaged := s.cfg.StringValue("AdminOracleUserID") != ""

	if txErr := db.Transaction(func(tx *database.DbTx) error {
		isNew, err := tx.ServerInit(uint64(id), s.generatePasswordHash(rootPassword), isManaged)
		if err != nil {
			return err
		}

		if isNew {
			s.Logger.Printf("Password for 'SuperUser' set to '%s'", rootPassword)
		}

		// Seed (or re-seed) the canonical per-vServer ACL rows on the root
		// channel. ACLAdd is OnConflict-UpdateAll, so this is idempotent on
		// the (server_id, channel_id, priority) unique key.
		if err := seedRootChannelACLs(tx, uint64(id)); err != nil {
			return err
		}

		// Load channel data from db
		channels, err := tx.ChannelList(uint64(id))
		if err != nil {
			return err
		}
		for _, v := range channels {
			channel := NewChannel(int(v.ChannelID), v.Name, mumbleproto.ChannelState_ChannelType(v.Type))
			channel.ACL.InheritACL = v.InheritACL

			// Additional information in channel_info table
			info, err := tx.ChannelInfoGets(v.ServerID, v.ChannelID, []database.ChannelInfoKey{
				database.ChannelDescription,
				database.ChannelMaxUsers,
				database.ChannelPosition,
			})
			if err != nil {
				return err
			}
			if v, ok := info[database.ChannelDescription]; ok {
				channel.DescriptionBlob = v
			}
			if v, ok := info[database.ChannelMaxUsers]; ok {
				channel.MaxUsers, _ = strconv.Atoi(v)
			}
			if v, ok := info[database.ChannelPosition]; ok {
				channel.Position, _ = strconv.Atoi(v)
			}

			// Restore ACL data
			acls, err := tx.ACLGet(v.ServerID, v.ChannelID)
			if err != nil {
				return err
			}
			for _, a := range acls {
				ACL := acl.ACL{
					UserId:    int(a.UserID.Int64),
					Group:     a.GroupName,
					ApplyHere: a.ApplyHere,
					ApplySubs: a.ApplySub,
					Allow:     acl.Permission(a.GrantPriv),
					Deny:      acl.Permission(a.RevokePriv),
				}
				if !a.UserID.Valid {
					ACL.UserId = -1
				}
				channel.ACL.ACLs = append(channel.ACL.ACLs, ACL)
			}

			// ACL group data
			groups, err := tx.GroupGetByChannel(v.ServerID, v.ChannelID)
			if err != nil {
				return err
			}
			for _, g := range groups {
				group := acl.Group{
					Name:        g.Name,
					Inherit:     g.Inherit,
					Inheritable: g.Inheritable,
					Add:         make(map[int]bool),
					Remove:      make(map[int]bool),
					Temporary:   make(map[int]bool),
				}

				members, err := tx.GroupMemberList(v.ServerID, g.GroupID)
				if err != nil {
					return err
				}
				for _, m := range members {
					if m.Addit {
						group.Add[int(m.UserID)] = true
					} else {
						group.Remove[int(m.UserID)] = true
					}
				}

				channel.ACL.Groups[g.Name] = group
			}
			s.Channels[int(v.ChannelID)] = channel
		}
		for _, v := range channels {
			if v.ParentID.Valid {
				s.Channels[int(v.ParentID.Int64)].AddChild(s.Channels[int(v.ChannelID)])
			}
		}

		return nil
	}); txErr != nil {
		// Seeding/load failed — propagate so the boot loop / management
		// CreateAndStart caller knows the vServer is not viable. The
		// previous code silently ignored this and went on to construct a
		// Server with an empty Channels map, which then Fatalf'd on the
		// first client connect.
		return nil, fmt.Errorf("seed/load vServer %d: %w", id, txErr)
	}

	s.listenerManager = NewChannelListenerManager()
	// Ban list
	s.readBanList()

	return
}

// Debugf implements debug-level printing for Servers.
func (server *Server) Debugf(format string, v ...interface{}) {
	server.Printf(format, v...)
}

// RootChannel returns the root channel (ChannelID=0) for this vServer.
//
// Defense in depth: if the root channel is missing (e.g. an earlier seeding
// transaction was rolled back due to a transient DB error, or the persistent
// row was hand-deleted), recover by creating it on demand instead of taking
// the whole process down. This matches the user-facing contract that a
// brand-new vServer is connectable on first try without operator
// intervention. The canonical seed path is still ServerInit +
// seedRootChannelACLs in NewServer; this fallback only fires when that path
// somehow left a hole.
func (server *Server) RootChannel() *Channel {
	if root, exists := server.Channels[0]; exists {
		return root
	}

	server.Printf("RootChannel: channel 0 missing in memory — repairing")
	var root *Channel
	if err := server.DB.Transaction(func(tx *database.DbTx) error {
		// channelInit is no-op if channel 0 already exists in the DB.
		if _, err := tx.ChannelInit(uint64(server.Id), "Root"); err != nil {
			return err
		}
		// Re-seed admin group + ACLs if missing. Both calls are idempotent.
		if _, err := tx.GroupEnsure(uint64(server.Id), 0, "admin"); err != nil {
			return err
		}
		if err := seedRootChannelACLs(tx, uint64(server.Id)); err != nil {
			return err
		}

		// Load the just-seeded ACLs + groups into the in-memory channel
		// inside the SAME tx, mirroring NewServer's load step. Without this
		// the repaired channel runs with empty ACL.ACLs / ACL.Groups in
		// memory — the admin group is powerless until the next process
		// restart re-reads the row from the database.
		root = NewChannel(0, "Root", mumbleproto.ChannelState_CHANNEL_TYPE_VOICE)
		acls, err := tx.ACLGet(uint64(server.Id), 0)
		if err != nil {
			return err
		}
		for _, a := range acls {
			ACL := acl.ACL{
				UserId:    int(a.UserID.Int64),
				Group:     a.GroupName,
				ApplyHere: a.ApplyHere,
				ApplySubs: a.ApplySub,
				Allow:     acl.Permission(a.GrantPriv),
				Deny:      acl.Permission(a.RevokePriv),
			}
			if !a.UserID.Valid {
				ACL.UserId = -1
			}
			root.ACL.ACLs = append(root.ACL.ACLs, ACL)
		}
		groups, err := tx.GroupGetByChannel(uint64(server.Id), 0)
		if err != nil {
			return err
		}
		for _, g := range groups {
			group := acl.Group{
				Name:        g.Name,
				Inherit:     g.Inherit,
				Inheritable: g.Inheritable,
				Add:         make(map[int]bool),
				Remove:      make(map[int]bool),
				Temporary:   make(map[int]bool),
			}
			members, err := tx.GroupMemberList(uint64(server.Id), g.GroupID)
			if err != nil {
				return err
			}
			for _, m := range members {
				if m.Addit {
					group.Add[int(m.UserID)] = true
				} else {
					group.Remove[int(m.UserID)] = true
				}
			}
			root.ACL.Groups[g.Name] = group
		}
		return nil
	}); err != nil {
		server.Fatalf("RootChannel: failed to repair root channel: %v", err)
	}

	server.Channels[0] = root
	return root
}

func (server *Server) generatePasswordHash(password string) database.UserPasswordHash {
	saltBytes := make([]byte, 8)
	_, err := rand.Read(saltBytes)
	if err != nil {
		server.Fatalf("Unable to read from crypto/rand: %v", err)
	}

	const PBKDF2Iter = 4096
	key := pbkdf2.Key([]byte(password), saltBytes, PBKDF2Iter, 48, sha512.New384)
	return database.UserPasswordHash{
		Salt:          []byte(hex.EncodeToString(saltBytes)),
		Hash:          hex.EncodeToString(key),
		KDFIterations: PBKDF2Iter,
	}
}

func (server *Server) verifyPasswordHash(hash database.UserPasswordHash, password string) (bool, error) {
	saltBytes, err := hex.DecodeString(string(hash.Salt))
	if err != nil {
		return false, err
	}

	key := pbkdf2.Key([]byte(password), saltBytes, hash.KDFIterations, 48, sha512.New384)
	return strings.EqualFold(hex.EncodeToString(key), strings.ToLower(hash.Hash)), nil
}

// SetSuperUserPassword sets password as the new SuperUser password
func (server *Server) SetSuperUserPassword(password string) {
	tx := server.DB.Tx()
	err := tx.UserSetAuth(uint64(server.Id), 0, server.generatePasswordHash(password))
	if err != nil {
		tx.Rollback()
		log.Fatalf("Failed to change SuperUser password: %v", err)
	}
	tx.Commit()
}

// SetServerPassword sets password as the new Server password
func (server *Server) SetServerPassword(password string) {
	tx := server.DB.Tx()
	err := tx.ConfigSet(uint64(server.Id), "password", password)
	if err != nil {
		tx.Rollback()
		log.Fatalf("Failed to change server password: %v", err)
	}
	tx.Commit()
}

// CheckSuperUserPassword checks whether password matches the set SuperUser password.
func (server *Server) CheckSuperUserPassword(password string) bool {
	tx := server.DB.Tx()
	user, err := tx.UserGetAuth(uint64(server.Id), "SuperUser")
	if err != nil {
		tx.Rollback()
		server.Fatalf("Unable to get superuser auth info: %v", err)
	}
	tx.Commit()

	ok, err := server.verifyPasswordHash(user.Password, password)
	if err != nil {
		server.Fatalf("Unable to verify password: %v", err)
	}
	return ok
}

// CheckServerPassword checks whether password matches the set Server password.
func (server *Server) CheckServerPassword(password string) bool {
	tx := server.DB.Tx()
	pw, err := tx.ConfigGet(uint64(server.Id), "password")
	if err != nil {
		tx.Rollback()
		log.Fatalf("Failed to get server password: %v", err)
	}
	tx.Commit()
	return pw == password
}

func (server *Server) hasServerPassword() bool {
	tx := server.DB.Tx()
	pw, err := tx.ConfigGet(uint64(server.Id), "password")
	if err != nil {
		tx.Rollback()
		log.Fatalf("Failed to get server password: %v", err)
	}
	tx.Commit()

	return pw != ""
}

// Called by the server to initiate a new client connection.
func (server *Server) handleIncomingClient(conn net.Conn) (err error) {
	client := new(Client)
	addr := conn.RemoteAddr()
	if addr == nil {
		err = errors.New("unable to extract address for client")
		return
	}

	client.lf = &clientLogForwarder{client, server.Logger}
	client.Logger = log.New(client.lf, "", 0)

	client.session = server.pool.Get()
	client.Printf("New connection: %v (%v)", conn.RemoteAddr(), client.Session())

	client.tcpaddr = addr.(*net.TCPAddr)
	client.server = server
	client.conn = conn
	client.reader = bufio.NewReader(client.conn)

	client.state = StateClientConnected

	client.user = nil
	client.Bandwidth = NewBandwidthRecorder()
	client.GlobalLimit = NewRateLimit(uint(server.cfg.IntValue("MessageLimit")), uint(server.cfg.IntValue("MessageBurst")))
	client.PluginLimit = NewRateLimit(uint(server.cfg.IntValue("PluginMessageLimit")), uint(server.cfg.IntValue("PluginMessageBurst")))

	// Extract user's cert hash
	// Only consider client certificates for direct connections, not WebSocket connections.
	// We do not support TLS-level client certificates for WebSocket client.
	if tlsconn, ok := client.conn.(*tls.Conn); ok {
		err = tlsconn.Handshake()
		if err != nil {
			client.Printf("TLS handshake failed: %v", err)
			client.Disconnect()
			return
		}

		state := tlsconn.ConnectionState()
		if len(state.PeerCertificates) > 0 {
			cert := state.PeerCertificates[0]
			hash := sha1.New()
			hash.Write(cert.Raw)
			sum := hash.Sum(nil)
			// todo(jim-k): verify certificate
			client.certHash = hex.EncodeToString(sum)
			if len(cert.EmailAddresses) > 0 {
				client.Email = cert.EmailAddresses[0]
			}
		}

		// Check whether the client's cert hash is banned
		if server.IsCertHashBanned(client.CertHash()) {
			client.Printf("Certificate hash is banned")
			client.Disconnect()
			return
		}
	}

	// Launch network reader
	go client.tlsRecvLoop()

	return
}

// RemoveClient removes a disconnected client from the server's
// internal representation.
func (server *Server) RemoveClient(client *Client, kicked bool) {
	delete(server.clients, client.Session())

	// HIGH #4: defer the session-pool Reclaim until media's SessionEnded
	// arrives. CloseSession is fire-and-forget; the SFU peer is still alive
	// at this point and a brand-new client picking up the same session uint
	// would collide. We stash the session in pendingReclaim and let the
	// handleMediaInbound SessionEnded path call Reclaim. A safety-net
	// sweeper forcibly reclaims entries older than pendingReclaimTimeout
	// (partition / lost-envelope case).
	//
	// If the client never had a media session at all (text-only, or
	// OpenSession failed) we Reclaim immediately — there's no pending media
	// teardown to wait for.
	enabled, _, nodeID, _ := client.mediaState()
	if enabled && nodeID != "" {
		server.sendCloseSession(client)
		if server.pendingReclaim != nil {
			server.pendingReclaim[client.Session()] = time.Now()
		} else {
			server.pool.Reclaim(client.Session())
		}
	} else {
		server.pool.Reclaim(client.Session())
	}

	// Remove client from channel
	channel := client.Channel
	if channel != nil {
		channel.RemoveClient(client)
	}

	// If the user was not kicked, broadcast a UserRemove message.
	// If the user is disconnect via a kick, the UserRemove message has already been sent
	// at this point.
	if !kicked && client.state > StateClientAuthenticated {
		err := server.broadcastProtoMessage(&mumbleproto.UserRemove{
			Session: proto.Uint32(client.Session()),
		})
		if err != nil {
			server.Panic("Unable to broadcast UserRemove message for disconnected client.")
		}
	}
}

// AddChannel adds a new channel to the server. Automatically assign it a channel ID.
func (server *Server) AddChannel(name string, parent *Channel, isTemp bool, channelType mumbleproto.ChannelState_ChannelType) (channel *Channel) {
	channelID := server.nextTempChanID
	if !isTemp {
		parentId := -1
		if parent != nil {
			parentId = parent.Id
		}

		tx := server.DB.Tx()
		ch, err := tx.ChannelAdd(uint64(server.Id), name, int64(parentId), uint8(channelType))
		if err != nil {
			tx.Rollback()
			return nil
		}
		tx.Commit()
		channelID = int(ch.ChannelID)
	} else {
		server.nextTempChanID += 1
	}

	channel = NewChannel(channelID, name, channelType)
	channel.temporary = isTemp
	if parent != nil {
		parent.AddChild(channel)
	}
	server.Channels[channelID] = channel
	return
}

// RemoveChanel removes a channel from the server.
func (server *Server) RemoveChanel(channel *Channel) {
	if channel.Id == 0 {
		server.Printf("Attempted to remove root channel.")
		return
	}

	delete(server.Channels, channel.Id)
	if !channel.IsTemporary() {
		tx := server.DB.Tx()
		err := tx.ChannelRemove(uint64(server.Id), uint64(channel.Id))
		if err != nil {
			tx.Rollback()
			return
		}
		tx.Commit()
	}
}

// Link two channels
func (server *Server) LinkChannels(channel *Channel, other *Channel) {
	channel.Links[other.Id] = other
	other.Links[channel.Id] = channel

	if !channel.IsTemporary() && !other.IsTemporary() {
		tx := server.DB.Tx()
		tx.ChannelLinkAdd(uint64(server.Id), uint64(channel.Id), uint64(other.Id))
		tx.ChannelLinkAdd(uint64(server.Id), uint64(other.Id), uint64(channel.Id))
		tx.Commit()
	}
}

// Unlink two channels
func (server *Server) UnlinkChannels(channel *Channel, other *Channel) {
	delete(channel.Links, other.Id)
	delete(other.Links, channel.Id)

	if !channel.IsTemporary() && !other.IsTemporary() {
		tx := server.DB.Tx()
		tx.ChannelLinkRemove(uint64(server.Id), uint64(channel.Id), uint64(other.Id))
		tx.ChannelLinkRemove(uint64(server.Id), uint64(other.Id), uint64(channel.Id))
		tx.Commit()
	}
}

// This is the synchronous handler goroutine.
// Important control channel messages are routed through this Goroutine
// to keep server state synchronized.
func (server *Server) handlerLoop() {
	regtick := time.Tick(time.Hour)
	pendingTick := time.NewTicker(pendingReclaimSweepInterval)
	defer pendingTick.Stop()
	for {
		select {
		// We're done. Stop the server's event handler
		case <-server.bye:
			return
		// Control channel messages
		case msg := <-server.incoming:
			server.handleIncomingMessage(msg)
		// Media-sidechannel inbound — runs on this goroutine so handlers
		// can read/write server.clients without locking. The atomic load
		// here is on the slow path (per-iteration) but only the channel
		// itself is read; the channel value is never reused once nilled
		// in cleanPerLaunchData (Stop sends bye first to unblock the
		// select).
		case job := <-derefMediaInbound(&server.mediaInbound):
			server.handleMediaInbound(job)
		// Remove a temporary channel
		case tempChannel := <-server.tempRemove:
			if tempChannel.IsEmpty() {
				server.RemoveChannel(tempChannel, nil)
			}
		// Finish client authentication. Send post-authentication
		// server info.
		case client := <-server.clientAuthenticated:
			server.finishAuthenticate(client)

		// Forced reclaim sweep for sessions whose SessionEnded never
		// arrived (partition / lost-envelope case — HIGH #4).
		case <-pendingTick.C:
			server.sweepPendingReclaims()

		// Server registration update
		// Tick every hour + a minute offset based on the server id.
		case <-regtick:
			server.RegisterPublicServer()
		}
	}
}

// Handle an Authenticate protobuf message.  This is handled in a separate
// goroutine to allow for remote authenticators that are slow to respond.
//
// Once a user has been authenticated, it will ping the server's handler
// routine, which will call the finishAuthenticate method on Server which
// will send the channel tree, user list, etc. to the client.
func (server *Server) handleAuthenticate(client *Client, msg *Message) {
	// Is this message not an authenticate message? If not, discard it...
	if msg.kind != mumbleproto.MessageAuthenticate {
		client.Panic("Unexpected message. Expected Authenticate.")
		return
	}

	auth := &mumbleproto.Authenticate{}
	err := proto.Unmarshal(msg.buf, auth)
	if err != nil {
		client.Panic("Unable to unmarshal Authenticate message.")
		return
	}

	// Set access tokens. Clients can set their access tokens any time
	// by sending an Authenticate message with he contents of their new
	// access token list.
	client.tokens = auth.Tokens
	server.ClearCaches()

	if client.state >= StateClientAuthenticated {
		// todo(jim-k): authenticated user handling is more complex in murmur, check it later.
		return
	}

	// Did we get a username?
	if auth.Username == nil || len(*auth.Username) == 0 {
		client.RejectAuth(mumbleproto.Reject_InvalidUsername, "Please specify a username to log in")
		return
	}

	client.Username = *auth.Username

	tx := server.DB.Tx()
	defer tx.Commit()

	userID := int64(-1)
	dbu, err := tx.UserGetAuth(uint64(server.Id), client.Username)
	if err != nil {
		client.Panicf("Failed to get user info: %v", err)
	}
	if dbu != nil {
		// First try to match with user password
		if dbu.Password.Hash != "" {
			success, err := server.verifyPasswordHash(dbu.Password, *auth.Password)
			if err != nil {
				client.Panicf("Failed to verify password: %v", err)
			}
			if success {
				userID = int64(dbu.UserID)
			} else {
				client.RejectAuth(mumbleproto.Reject_WrongUserPW, "")
				return
			}
		} else if dbu.UserID == 0 {
			// For superuser, empty password is not allowed
			client.RejectAuth(mumbleproto.Reject_WrongUserPW, "")
			return
		}
	}

	// Name match failed, try match with certificate
	if userID < 0 && client.HasCertificate() {
		// Try match by cert
		uid, err := tx.UserInfoGetUID(uint64(server.Id), database.UserHash, client.CertHash())
		if err != nil {
			client.Panicf("Failed to get user info from cert hash: %v", err)
		}
		// If the certificate is verified, try to match with user email
		if !uid.Valid && client.IsCertificateVerified() {
			uid, err = tx.UserInfoGetUID(uint64(server.Id), database.UserEmail, client.Email)
			if err != nil {
				client.Panicf("Failed to get user info from cert hash: %v", err)
			}
		}
		if uid.Valid {
			userID = uid.Int64
			dbu, err = tx.UserGetInfo(uint64(server.Id), uint64(userID))
			if err != nil {
				client.Panicf("Failed to get user info from cert hash: %v", err)
			}
			client.Username = dbu.Name
		}
	}

	if userID >= 0 {
		user, ok := server.Users[uint32(userID)]
		if !ok {
			user = UserFromDatabase(dbu, &tx)
			server.Users[uint32(userID)] = user
		}
		client.user = user
	} else if dbu != nil {
		// Non of user password or certificate check is pass
		client.RejectAuth(mumbleproto.Reject_WrongUserPW, "")
		return
	}

	// Update certificate from hash
	if userID > 0 && client.HasCertificate() {
		info := make(map[database.UserInfoKey]string)
		if len(client.certHash) > 0 {
			info[database.UserHash] = client.certHash
		}
		if len(client.Email) > 0 {
			info[database.UserEmail] = client.Email
		}
		err = tx.UserInfoSet(uint64(server.Id), uint64(userID), info)
		if err != nil {
			server.Printf("Failed to update user cert and email: %v", err)
		}
	}

	if client.user == nil && server.hasServerPassword() {
		if auth.Password == nil || !server.CheckServerPassword(*auth.Password) {
			client.RejectAuth(mumbleproto.Reject_WrongServerPW, "Invalid server password")
			return
		}
	}

	// Oracle / Takusen SSO. We run introspection in this same goroutine —
	// it's already off the accept loop, and the 5s HTTP timeout inside
	// introspectOracleToken bounds the worst case.
	oracleCfg := OracleIntrospectConfig{
		URL:          server.cfg.StringValue("OracleIntrospectionURL"),
		ClientID:     server.cfg.StringValue("OracleClientID"),
		ClientSecret: server.cfg.StringValue("OracleClientSecret"),
	}
	oracleOnly := server.cfg.BoolValue("OracleOnly")
	oracleToken := auth.GetOracleToken()
	switch {
	case oracleToken != "" && oracleCfg.Enabled():
		result, err := introspectOracleToken(oracleCfg, oracleToken)
		if err != nil || result == nil || !result.Active {
			// Log every failure mode so an operator debugging "why am I
			// not getting admin even though I'm sending a token" can tell
			// whether the AS rejected it (active=false), returned an empty
			// body (result==nil), or the HTTP call itself blew up (err).
			// Without these lines a non-OracleOnly server silently drops the
			// token and treats the client as anonymous — invisible from the
			// logs.
			switch {
			case err != nil:
				server.Printf("Oracle introspection failed for %v: %v", client.Session(), err)
			case result == nil:
				server.Printf("Oracle introspection returned no result for %v (treating as anonymous)", client.Session())
			default: // result != nil && !result.Active
				server.Printf("Oracle introspection returned active=false for %v (treating as anonymous)", client.Session())
			}
			if oracleOnly {
				client.RejectAuth(mumbleproto.Reject_AuthenticatorFail,
					"Oracle authentication failed")
				return
			}
			// Fall back to anonymous — proceed as if no token was sent.
		} else {
			client.OracleSub = result.Sub
			client.OracleHandle = result.PreferredUsername
			client.OracleVerified = true

			// Managed-mode owner grant: if the introspected Oracle `sub`
			// matches the AdminOracleUserID this vServer was created with
			// (see pkg/management/management.proto and
			// pkg/management/service.go), promote this client to
			// SuperUser-equivalent. The grant is gated on
			// OracleVerified=true above — an Oracle token that FAILED
			// introspection cannot reach this branch, so a forged token
			// claiming a matching `sub` is rejected before we ever read
			// the AdminOracleUserID config. Self-host servers leave
			// AdminOracleUserID empty in DefaultCfg and never hit this
			// path, so behaviour is unchanged. Defense-in-depth: the
			// `adminID != ""` guard short-circuits the empty-vs-empty match
			// case (a vServer with no admin configured cannot grant to a
			// token with an empty `sub`).
			//
			// We set client.superUser as a side-channel flag instead of
			// overwriting client.user with a synthesised &User{Id: 0}. The
			// overwrite approach caused two real problems: (a) every
			// Oracle-admin's ShownName became "SuperUser" even when they
			// were also a registered local user, and (b) finishAuthenticate's
			// `UserId() == 0` dedup collapsed all concurrent Oracle-admin
			// connections (and any concurrent local-password SuperUser)
			// onto one identity, rejecting the second connection with
			// Reject_UsernameInUse. With the flag, IsSuperUser() and
			// acl.HasPermission's UserId()==0 short-circuit still grant
			// blanket admin to anonymous Oracle admins, while registered
			// users keep their real UserId so per-identity dedup works.
			if shouldGrantOracleAdmin(server.cfg.StringValue("AdminOracleUserID"), result.Sub) {
				client.superUser = true
				server.Printf("Client %v granted SuperUser via Oracle owner mapping (sub=%s)",
					client.Session(), result.Sub)
			}
		}
	case oracleToken != "" && !oracleCfg.Enabled():
		// Client offered a token but the server has no introspection
		// endpoint configured. In OracleOnly mode there is no way to
		// satisfy the policy, so reject; otherwise silently drop the
		// token and proceed anonymously.
		server.Printf("Client %v sent oracle_token but server has no introspection configured",
			client.Session())
		if oracleOnly {
			client.RejectAuth(mumbleproto.Reject_AuthenticatorFail,
				"Oracle authentication is required but not configured on this server")
			return
		}
	case oracleToken == "" && oracleOnly:
		client.RejectAuth(mumbleproto.Reject_AuthenticatorFail,
			"This server requires Oracle authentication")
		return
	}

	// Phase 1 final pass CRITICAL #2: the actual setupWebRTCForClient call is
	// deferred to finishAuthenticate, which runs on the handlerLoop. Doing it
	// here (on the per-client auth goroutine) would race the OpenSession
	// envelope against server.clients[session] = client and drop media's
	// near-instant SdpSignal reply on the floor. We capture the WebRTC
	// request flag on the client so finishAuthenticate knows to fire it.
	client.wantsWebRTC = auth.GetWebrtc()

	// No more OCB-AES key derivation / CryptSetup push here — `pkg/cryptstate/`
	// is gone and packet-type 15 is permanently burned. WebRTC's DTLS-SRTP is
	// the encryption boundary now.

	// Add codecs
	client.codecs = auth.CeltVersions
	client.opus = auth.GetOpus()

	client.state = StateClientAuthenticated
	client.Bandwidth.ResetIdleSeconds()
	server.clientAuthenticated <- client
}

// The last part of authentication runs in the server's synchronous handler.
func (server *Server) finishAuthenticate(client *Client) {
	// If the client succeeded in proving to the server that it should be granted
	// the credentials of a registered user, do some sanity checking to make sure
	// that user isn't already connected.
	//
	// If the user is already connected, try to check whether this new client is
	// connecting from the same IP address. If that's the case, disconnect the
	// previous client and let the new guy in.
	if client.user != nil {
		found := false
		var oldClient *Client = nil
		for _, connectedClient := range server.clients {
			if connectedClient.UserId() == client.UserId() {
				found = true
				oldClient = connectedClient
				break
			}
		}
		// The user is already present on the server.
		if found {
			if client.tcpaddr.String() != oldClient.tcpaddr.String() {
				client.RejectAuth(mumbleproto.Reject_UsernameInUse, "A client is already connected using those credentials.")
				return
			}
		}

		// No, that user isn't already connected. Move along.
	}

	maxUsers := server.cfg.IntValue("MaxUsers")
	if len(server.Users) >= maxUsers {
		client.RejectAuth(mumbleproto.Reject_ServerFull, fmt.Sprintf("Server is full (max %d users)", maxUsers))
		return
	}

	// Add the client to the connected list
	server.clients[client.Session()] = client

	// Now that the client is in server.clients, start the WebRTC handshake.
	// Phase 1 final pass CRITICAL #2: running this here (on the handlerLoop)
	// means the inbound SdpSignal envelope from media — which arrives
	// microseconds later — finds the client by session. Doing it from the
	// per-client authenticate goroutine raced and dropped the offer.
	if client.wantsWebRTC {
		if err := server.setupWebRTCForClient(client); err != nil {
			server.Printf("WebRTC setup failed for %v: %v", client.Session(), err)
		}
	}

	// Warn clients without CELT support that they might not be able to talk to everyone else.
	if len(client.codecs) == 0 {
		client.codecs = []int32{CeltCompatBitstream}
		server.Printf("Client %v connected without CELT codecs. Faking compat bitstream.", client.Session())
		if server.Opus && !client.opus {
			client.sendMessage(&mumbleproto.TextMessage{
				Session: []uint32{client.Session()},
				Message: proto.String("<strong>WARNING:</strong> Your client doesn't support the CELT codec, you won't be able to talk to or hear most clients. Please make sure your client was built with CELT support."),
			})
		}
	}

	// First, check whether we need to tell the other connected
	// clients to switch to a codec so the new guy can actually speak.
	server.updateCodecVersions(client)

	client.sendChannelList()

	channel := server.RootChannel()
	if client.IsRegistered() {
		lastChannel, ok := server.Channels[client.user.LastChannelId]
		if ok && acl.HasPermission(&lastChannel.ACL, client, acl.EnterPermission) && !server.IsChannelFull(lastChannel, client) {
			channel = lastChannel
		} else {
			defaultCh, ok := server.Channels[server.cfg.IntValue("DefaultChannel")]
			if ok && acl.HasPermission(&defaultCh.ACL, client, acl.EnterPermission) && !server.IsChannelFull(defaultCh, client) {
				channel = defaultCh
			}
		}
	}

	if server.IsChannelFull(channel, client) {
		client.RejectAuth(mumbleproto.Reject_ServerFull, "Server channels are full")
		return
	}

	userstate := &mumbleproto.UserState{
		Session:   proto.Uint32(client.Session()),
		Name:      proto.String(client.ShownName()),
		ChannelId: proto.Uint32(uint32(channel.Id)),
	}

	// Include SSRC for WebRTC clients. Phase 1 final pass CRITICAL #1: the
	// SSRC is the value media ECHOED in SessionEstablished, not the value
	// control intended to use — those are the same in the steady state but
	// only one side of that equation is authoritative. Held at 0 until the
	// echo lands; a follow-up UserState broadcast in handleMediaInbound
	// fills it in for late peers (see broadcastUserSSRC).
	if enabled, ssrc, _, _ := client.mediaState(); enabled && ssrc != 0 {
		userstate.Ssrc = proto.Uint32(ssrc)
	}

	// Broadcast Oracle/Takusen identity so other clients can render a
	// verified badge next to this user. Only set when introspection
	// actually succeeded — never inferred from the absence of a token.
	if client.OracleVerified {
		userstate.Verified = proto.Bool(true)
		if client.OracleHandle != "" {
			userstate.OracleHandle = proto.String(client.OracleHandle)
		}
	}

	if client.HasCertificate() {
		userstate.Hash = proto.String(client.CertHash())
	}

	// Wire UserId is the client-side signal for "this session is logged in
	// as a known identity" — the TS client treats UserId === 0 as
	// SuperUser for permission gates (e.g. server-settings-dialog). Oracle-
	// granted admins have `client.user == nil` but `IsSuperUser() == true`
	// and `UserId() == 0`; without this branch the wire packet omits
	// UserId for them and every SuperUser-gated UI stays locked closed.
	// Texture / comment blobs still require a registered user row, so
	// that branch stays gated on IsRegistered().
	if client.IsRegistered() || client.IsSuperUser() {
		userstate.UserId = proto.Uint32(uint32(client.UserId()))
	}

	if client.IsRegistered() {
		if client.user.HasTexture() {
			// Does the client support blobs?
			if client.Version.SupportCommentTextureHash() {
				userstate.TextureHash = client.user.TextureBlobHashBytes()
			} else {
				buf, err := blobStore.Get(client.user.TextureBlob)
				if err != nil {
					server.Panicf("Blobstore error: %v", err.Error())
				}
				userstate.Texture = buf
			}
		}

		if client.user.HasComment() {
			// Does the client support blobs?
			if client.Version.SupportCommentTextureHash() {
				userstate.CommentHash = client.user.CommentBlobHashBytes()
			} else {
				buf, err := blobStore.Get(client.user.CommentBlob)
				if err != nil {
					server.Panicf("Blobstore error: %v", err.Error())
				}
				userstate.Comment = proto.String(string(buf))
			}
		}
	}

	server.userEnterChannel(client, channel, userstate)
	if err := server.broadcastProtoMessage(userstate); err != nil {
		// Server panic?
	}

	server.sendUserList(client)

	sync := &mumbleproto.ServerSync{}
	sync.Session = proto.Uint32(client.Session())
	sync.MaxBandwidth = proto.Uint32(server.cfg.Uint32Value("MaxBandwidth"))
	sync.WelcomeText = proto.String(server.cfg.StringValue("WelcomeText"))
	if client.IsSuperUser() {
		sync.Permissions = proto.Uint64(uint64(acl.AllPermissions))
	} else {
		// fixme(mkrautz): previously we calculated the user's
		// permissions and sent them to the client in here. This
		// code relied on our ACL cache, but that has been temporarily
		// thrown out because of our ACL handling code moving to its
		// own package.
		sync.Permissions = nil
	}
	// Embed the server-level default quality profile so clients without a
	// WebRTC voice token (text-only / declined-media paths) still get codec
	// / ladder / jitter / FEC configuration at join time. Clients with
	// WebRTC sessions will see this AND a bound profile inside
	// `VoiceTokenGrant` — the grant wins for the audible session.
	//
	// Phase 2 wire surface: the profile DB / per-channel override lands in
	// phase 1 step 9; until then we stamp the Hachiman-Standard defaults
	// inline so the wire field is exercised and clients can be developed
	// against it.
	sync.QualityProfile = defaultQualityProfile()
	if err := client.sendMessage(sync); err != nil {
		client.Panicf("%v", err)
		return
	}

	err := client.sendMessage(&mumbleproto.ServerConfig{
		AllowHtml:          proto.Bool(server.cfg.BoolValue("AllowHTML")),
		MessageLength:      proto.Uint32(server.cfg.Uint32Value("MaxTextMessageLength")),
		ImageMessageLength: proto.Uint32(server.cfg.Uint32Value("MaxImageMessageLength")),
		MaxUsers:           proto.Uint32(server.cfg.Uint32Value("MaxUsers")),
		RecordingAllowed:   proto.Bool(server.cfg.BoolValue("AllowRecording")),
	})
	if err != nil {
		client.Panicf("%v", err)
		return
	}

	client.state = StateClientReady
	client.clientReady <- true
}

func (server *Server) updateCodecVersions(connecting *Client) {
	codecusers := map[int32]int{}
	var (
		winner     int32
		count      int
		users      int
		opus       int
		enableOpus bool
		txtMsg     *mumbleproto.TextMessage = &mumbleproto.TextMessage{
			Message: proto.String("<strong>WARNING:</strong> Your client doesn't support the Opus codec the server is switching to, you won't be able to talk or hear anyone. Please upgrade to a client with Opus support."),
		}
	)

	for _, client := range server.clients {
		users++
		if client.opus {
			opus++
		}
		for _, codec := range client.codecs {
			codecusers[codec] += 1
		}
	}

	for codec, users := range codecusers {
		if users > count {
			count = users
			winner = codec
		}
		if users == count && codec > winner {
			winner = codec
		}
	}

	var current int32
	if server.PreferAlphaCodec {
		current = server.AlphaCodec
	} else {
		current = server.BetaCodec
	}

	enableOpus = users == opus

	if winner != current {
		if winner == CeltCompatBitstream {
			server.PreferAlphaCodec = true
		} else {
			server.PreferAlphaCodec = !server.PreferAlphaCodec
		}

		if server.PreferAlphaCodec {
			server.AlphaCodec = winner
		} else {
			server.BetaCodec = winner
		}
	} else if server.Opus == enableOpus {
		if server.Opus && connecting != nil && !connecting.opus {
			txtMsg.Session = []uint32{connecting.Session()}
			connecting.sendMessage(txtMsg)
		}
		return
	}

	server.Opus = enableOpus

	err := server.broadcastProtoMessage(&mumbleproto.CodecVersion{
		Alpha:       proto.Int32(server.AlphaCodec),
		Beta:        proto.Int32(server.BetaCodec),
		PreferAlpha: proto.Bool(server.PreferAlphaCodec),
		Opus:        proto.Bool(server.Opus),
	})
	if err != nil {
		server.Printf("Unable to broadcast.")
		return
	}

	if server.Opus {
		for _, client := range server.clients {
			if !client.opus && client.state == StateClientReady {
				txtMsg.Session = []uint32{connecting.Session()}
				err := client.sendMessage(txtMsg)
				if err != nil {
					client.Panicf("%v", err)
				}
			}
		}
		if connecting != nil && !connecting.opus {
			txtMsg.Session = []uint32{connecting.Session()}
			connecting.sendMessage(txtMsg)
		}
	}

	server.Printf("CELT codec switch %#x %#x (PreferAlpha %v) (Opus %v)", uint32(server.AlphaCodec), uint32(server.BetaCodec), server.PreferAlphaCodec, server.Opus)
}

func (server *Server) sendUserList(client *Client) {
	for _, connectedClient := range server.clients {
		if connectedClient.state != StateClientReady {
			continue
		}
		if connectedClient == client {
			continue
		}

		userstate := &mumbleproto.UserState{
			Session:   proto.Uint32(connectedClient.Session()),
			Name:      proto.String(connectedClient.ShownName()),
			ChannelId: proto.Uint32(uint32(connectedClient.Channel.Id)),
		}

		if connectedClient.HasCertificate() {
			userstate.Hash = proto.String(connectedClient.CertHash())
		}

		// See the matching block in the own-userstate path above: stamping
		// UserId for Oracle-granted SuperUsers (client.user == nil, but
		// UserId() == 0) is what unlocks the TS client's IsSuperUser
		// permission gates.
		if connectedClient.IsRegistered() || connectedClient.IsSuperUser() {
			userstate.UserId = proto.Uint32(uint32(connectedClient.UserId()))
		}

		if connectedClient.IsRegistered() {
			if connectedClient.user.HasTexture() {
				// Does the client support blobs?
				if client.Version.SupportCommentTextureHash() {
					userstate.TextureHash = connectedClient.user.TextureBlobHashBytes()
				} else {
					buf, err := blobStore.Get(connectedClient.user.TextureBlob)
					if err != nil {
						server.Panicf("Blobstore error: %v", err.Error())
					}
					userstate.Texture = buf
				}
			}

			if connectedClient.user.HasComment() {
				// Does the client support blobs?
				if client.Version.SupportCommentTextureHash() {
					userstate.CommentHash = connectedClient.user.CommentBlobHashBytes()
				} else {
					buf, err := blobStore.Get(connectedClient.user.CommentBlob)
					if err != nil {
						server.Panicf("Blobstore error: %v", err.Error())
					}
					userstate.Comment = proto.String(string(buf))
				}
			}
		}

		if connectedClient.Mute {
			userstate.Mute = proto.Bool(true)
		}
		if connectedClient.Suppress {
			userstate.Suppress = proto.Bool(true)
		}
		if connectedClient.SelfMute {
			userstate.SelfMute = proto.Bool(true)
		}
		if connectedClient.SelfDeaf {
			userstate.SelfDeaf = proto.Bool(true)
		}
		if connectedClient.PrioritySpeaker {
			userstate.PrioritySpeaker = proto.Bool(true)
		}
		if connectedClient.Recording {
			userstate.Recording = proto.Bool(true)
		}
		if connectedClient.PluginContext != nil || len(connectedClient.PluginContext) > 0 {
			userstate.PluginContext = connectedClient.PluginContext
		}
		if len(connectedClient.PluginIdentity) > 0 {
			userstate.PluginIdentity = proto.String(connectedClient.PluginIdentity)
		}
		// Mirror the same Oracle fields broadcast at first-join so a
		// late-arriving client sees the verified badge for users that
		// were already present.
		if connectedClient.OracleVerified {
			userstate.Verified = proto.Bool(true)
			if connectedClient.OracleHandle != "" {
				userstate.OracleHandle = proto.String(connectedClient.OracleHandle)
			}
		}

		err := client.sendMessage(userstate)
		if err != nil {
			// Server panic?
			continue
		}
	}
}

// Send a client its permissions for channel.
//
// The legacy short-circuit was "skip the send entirely for SuperUser" — fine
// for the original Mumble desktop client (which knew it was the SuperUser
// from the local-password login and synthesised AllPermissions locally) but
// fatal for any client that treats PermissionQuery as a real request/reply:
// the reply never came, the client's `await fetchChannelPermissions` timed
// out (see pkgs/hachiman-node/src/channel.ts), and the UI's "create channel"
// affordance hung. Oracle-granted SuperUsers compound this — there's no
// local-password handshake for the client to infer SuperUser from in the
// first place, so silence is genuinely indistinguishable from "I have no
// permissions".
//
// Send AllPermissions explicitly for SuperUsers, mirroring the non-SuperUser
// branch (which is itself stubbed to AllPermissions until the proper ACL
// computation is wired — see the older fixme below).
func (server *Server) sendClientPermissions(client *Client, channel *Channel) {
	// fixme(mkrautz): re-add ACL caching + actually compute the per-channel
	// permission set. For now both branches collapse to AllPermissions —
	// matching the prior non-SuperUser behaviour — so the client UI can
	// proceed deterministically.
	perm := acl.AllPermissions
	client.sendMessage(&mumbleproto.PermissionQuery{
		ChannelId:   proto.Uint32(uint32(channel.Id)),
		Permissions: proto.Uint32(uint32(perm)),
	})
}

type ClientPredicate func(client *Client) bool

func (server *Server) broadcastProtoMessageWithPredicate(msg interface{}, clientcheck ClientPredicate) error {
	for _, client := range server.clients {
		if !clientcheck(client) {
			continue
		}
		if client.state < StateClientAuthenticated {
			continue
		}
		err := client.sendMessage(msg)
		if err != nil {
			return err
		}
	}

	return nil
}

func (server *Server) broadcastProtoMessage(msg interface{}) (err error) {
	err = server.broadcastProtoMessageWithPredicate(msg, func(client *Client) bool { return true })
	return
}

func (server *Server) handleIncomingMessage(msg *Message) {
	server.Printf("Incoming message type: %d - %d", msg.kind, msg.client.session)
	switch msg.kind {
	case mumbleproto.MessageAuthenticate:
		server.handleAuthenticate(msg.client, msg)
	case mumbleproto.MessagePing:
		server.handlePingMessage(msg.client, msg)
	case mumbleproto.MessageChannelRemove:
		server.handleChannelRemoveMessage(msg.client, msg)
	case mumbleproto.MessageChannelState:
		server.handleChannelStateMessage(msg.client, msg)
	case mumbleproto.MessageUserState:
		server.handleUserStateMessage(msg.client, msg)
	case mumbleproto.MessageUserRemove:
		server.handleUserRemoveMessage(msg.client, msg)
	case mumbleproto.MessageBanList:
		server.handleBanListMessage(msg.client, msg)
	case mumbleproto.MessageTextMessage:
		server.handleTextMessage(msg.client, msg)
	case mumbleproto.MessageACL:
		server.handleAclMessage(msg.client, msg)
	case mumbleproto.MessageQueryUsers:
		server.handleQueryUsers(msg.client, msg)
	case mumbleproto.MessageContextAction:
		server.handleContextAction(msg.client, msg)
	case mumbleproto.MessageUserList:
		server.handleUserList(msg.client, msg)
	case mumbleproto.MessagePermissionQuery:
		server.handlePermissionQuery(msg.client, msg)
	case mumbleproto.MessageUserStats:
		server.handleUserStatsMessage(msg.client, msg)
	case mumbleproto.MessageRequestBlob:
		server.handleRequestBlob(msg.client, msg)
	case mumbleproto.MessageVersion:
		server.handleVersionMessage(msg.client, msg)
	case mumbleproto.MessagePluginDataTransmission:
		server.handlePluginDataTransmission(msg.client, msg)
	case mumbleproto.MessageWebRTC:
		server.handleWebRTCMessage(msg.client, msg)
	case mumbleproto.MessageIceCandidate:
		server.handleIceCandidateMessage(msg.client, msg)
	case mumbleproto.MessageTalkingState:
		server.handleTalkingStateMessage(msg.client, msg)
	case mumbleproto.MessageRequestChannelMessages:
		server.handleRequestChannelMessages(msg.client, msg)
	case mumbleproto.MessageRelayMetricsQuery:
		server.handleRelayMetricsQuery(msg.client, msg)
	default:
		// Packet-type IDs 1 (UDPTunnel) / 15 (CryptSetup) / 19 (VoiceTarget)
		// are permanently burned in the registry — they were the legacy
		// native UDP voice / OCB nonce-resync / whisper-target paths,
		// deleted in media-plane phase 2 / phase 1 step 3. Refuse them
		// quietly (log and drop) rather than panicking on the nil
		// ProtoReflect of the old stubs. Unknown IDs land here too and get
		// the same treatment — a remote can't crash us by sending one.
		msg.client.Printf(
			"dropping legacy / unknown control packet kind=%d len=%d",
			msg.kind, len(msg.buf),
		)
	}
}

// ClearCaches is a no-op: per-client whisper caches retired with the native
// UDP voice path (phase 1 step 3). Kept so the existing call sites keep
// compiling; remove once the call sites are themselves rewritten against the
// sidechannel `SubscriptionMatrixUpdate` flow.
func (server *Server) ClearCaches() {
	for _, client := range server.clients {
		client.ClearCaches()
	}
}

// Helper method for users entering new channels
func (server *Server) userEnterChannel(client *Client, channel *Channel, userstate *mumbleproto.UserState) {
	if client.Channel == channel {
		return
	}

	oldchan := client.Channel
	var oldRoomID string
	if oldchan != nil {
		oldRoomID = strconv.Itoa(oldchan.Id)
		oldchan.RemoveClient(client)
		if oldchan.IsTemporary() && oldchan.IsEmpty() {
			server.tempRemove <- oldchan
		}
	}
	channel.AddClient(client)

	// HIGH #3: media's fanout topology needs to follow channel moves; the
	// SDP doesn't carry channel/room semantics, so a SessionMove envelope
	// transfers the session_id between r.rooms entries on the SFU side.
	// No-op if the client has no WebRTC session bound (text-only).
	if client.isWebRTCEnabled() {
		newRoomID := strconv.Itoa(channel.Id)
		server.sendSessionMove(client, oldRoomID, newRoomID)
	}

	server.ClearCaches()

	if client.IsRegistered() {
		if err := server.UserSetLastChannel(client.user, channel); err != nil {
			server.Panicf("Failed to set user last channel: %v", err)
		}
	}

	canspeak := acl.HasPermission(&channel.ACL, client, acl.SpeakPermission)
	if canspeak == client.Suppress {
		client.Suppress = !canspeak
		userstate.Suppress = proto.Bool(client.Suppress)
	}

	server.sendClientPermissions(client, channel)
	if channel.parent != nil {
		server.sendClientPermissions(client, channel.parent)
	}
}

// Register a client on the server.
func (s *Server) RegisterClient(client *Client) (uid uint32, err error) {
	tx := s.DB.Tx()
	u, err := tx.UserRegister(uint64(s.Id), client.Username)
	if err != nil {
		tx.Rollback()
		return
	}

	user, err := NewUser(uint32(u.UserID), client.Username)
	if err != nil {
		tx.Rollback()
		return 0, err
	}

	// Grumble can only register users with certificates.
	if !client.HasCertificate() {
		tx.Rollback()
		return 0, errors.New("no cert hash")
	}

	// Save user certficate and email into database
	info := make(map[database.UserInfoKey]string)
	if client.Email != "" {
		info[database.UserEmail] = client.Email
	}
	if client.certHash != "" {
		info[database.UserHash] = client.CertHash()
	}
	err = tx.UserInfoSet(uint64(s.Id), u.UserID, info)
	if err != nil {
		tx.Rollback()
		return 0, err
	}

	uid = user.Id
	s.Users[uid] = user

	return uid, nil
}

// RemoveRegistration removes a registered user.
func (s *Server) RemoveRegistration(uid uint32) (err error) {
	_, ok := s.Users[uid]
	if !ok {
		return errors.New("unknown user ID")
	}

	tx := s.DB.Tx()
	err = tx.UserUnregister(uint64(s.Id), uint64(uid))
	if err != nil {
		tx.Rollback()
		return
	}
	tx.Commit()

	// Remove from user maps
	delete(s.Users, uid)

	// Remove from groups and ACLs.
	s.removeRegisteredUserFromChannel(uid, s.RootChannel())

	return nil
}

// Remove references for user id uid from channel. Traverses subchannels.
func (s *Server) removeRegisteredUserFromChannel(uid uint32, channel *Channel) {

	newACL := []acl.ACL{}
	for _, chanacl := range channel.ACL.ACLs {
		if chanacl.UserId == int(uid) {
			continue
		}
		newACL = append(newACL, chanacl)
	}
	channel.ACL.ACLs = newACL

	for _, grp := range channel.ACL.Groups {
		delete(grp.Add, int(uid))
		delete(grp.Remove, int(uid))
		delete(grp.Temporary, int(uid))
	}

	for _, subChan := range channel.children {
		s.removeRegisteredUserFromChannel(uid, subChan)
	}
}

// RemoveChannel removes a channel
func (server *Server) RemoveChannel(channel *Channel, dest *Channel) {
	// Can't remove root
	if channel == server.RootChannel() {
		return
	}

	if dest == nil {
		dest = channel.parent
	}

	// Remove all subchannels
	for _, subChannel := range channel.children {
		server.RemoveChannel(subChannel, dest)
	}

	tx := server.DB.Tx()
	defer tx.Commit()

	// Remove all links
	for _, linkedChannel := range channel.Links {
		err := tx.ChannelLinkRemove(uint64(server.Id), uint64(linkedChannel.Id), uint64(channel.Id))
		if err != nil {
			tx.Rollback()
			server.Panicf("Failed to remove channel: %v", err)
		}

		delete(linkedChannel.Links, channel.Id)
	}

	// Remove all clients
	for _, client := range channel.clients {
		target := dest
		for target.parent != nil && (!acl.HasPermission(&target.ACL, client, acl.EnterPermission) || server.IsChannelFull(target, client)) {
			target = target.parent
		}

		userstate := &mumbleproto.UserState{}
		userstate.Session = proto.Uint32(client.Session())
		userstate.ChannelId = proto.Uint32(uint32(target.Id))
		server.userEnterChannel(client, target, userstate)
		if err := server.broadcastProtoMessage(userstate); err != nil {
			server.Panicf("%v", err)
		}
	}

	// Cascade-delete the persisted chat history first. Voice channels
	// have nothing persisted (live-only chat); text channels carry every
	// TextMessage broadcast under this channel id. Without this, deleting
	// a text channel would leak its messages forever — they'd be
	// unreachable through the normal history query (which filters by
	// channel_id) but still on disk, and a recycled channel id (next
	// auto-increment after enough churn) could even resurface them.
	// Same tx as ChannelRemove so either both apply or neither does.
	if err := tx.MessageDeleteByChannel(server.Id, channel.Id); err != nil {
		tx.Rollback()
		server.Panicf("Failed to remove channel messages: %v", err)
	}

	// Remove from database
	err := tx.ChannelRemove(uint64(server.Id), uint64(channel.Id))
	if err != nil {
		tx.Rollback()
		server.Panicf("Failed to remove channel: %v", err)
	}

	// Remove the channel itself
	parent := channel.parent
	delete(parent.children, channel.Id)
	delete(server.Channels, channel.Id)
	chanremove := &mumbleproto.ChannelRemove{
		ChannelId: proto.Uint32(uint32(channel.Id)),
	}
	if err := server.broadcastProtoMessage(chanremove); err != nil {
		server.Panicf("%v", err)
	}
}

func (server *Server) readBanList() {
	err := server.DB.Transaction(func(tx *database.DbTx) error {
		bans, err := tx.BanRead(uint64(server.Id))
		if err != nil {
			return err
		}
		server.Bans = make([]ban.Ban, len(bans))
		for i, v := range bans {
			server.Bans[i] = ban.Ban{
				IP:       v.Base,
				Mask:     v.Mask,
				Username: v.Name,
				CertHash: string(v.Hash),
				Reason:   v.Reason,
				Start:    v.Start.Unix(),
				Duration: uint32(v.Duraion),
			}
		}
		return nil
	})
	if err != nil {
		server.Panic(err)
	}
}

func (server *Server) saveBanList() {
	banList := make([]database.Ban, len(server.Bans))
	for i, v := range server.Bans {
		banList[i] = database.Ban{
			Base:    v.IP,
			Mask:    v.Mask,
			Name:    v.Username,
			Hash:    []byte(v.CertHash),
			Reason:  v.Reason,
			Start:   time.Unix(v.Start, 0),
			Duraion: int(v.Duration),
		}
	}

	err := server.DB.Transaction(func(tx *database.DbTx) error {
		return tx.BanWrite(banList)
	})
	if err != nil {
		server.Panic(err)
		return
	}
}

// RemoveExpiredBans removes expired bans
func (server *Server) RemoveExpiredBans() {
	server.banlock.Lock()
	defer server.banlock.Unlock()

	newBans := []ban.Ban{}
	update := false
	for _, ban := range server.Bans {
		if !ban.IsExpired() {
			newBans = append(newBans, ban)
		} else {
			update = true
		}
	}

	if update {
		server.Bans = newBans
		server.saveBanList()
	}
}

// IsConnectionBanned Is the incoming connection conn banned?
func (server *Server) IsConnectionBanned(conn net.Conn) bool {
	server.banlock.RLock()
	defer server.banlock.RUnlock()

	for _, ban := range server.Bans {
		addr := conn.RemoteAddr().(*net.TCPAddr)
		if ban.Match(addr.IP) && !ban.IsExpired() {
			return true
		}
	}

	return false
}

// IsCertHashBanned Is the certificate hash banned?
func (server *Server) IsCertHashBanned(hash string) bool {
	server.banlock.RLock()
	defer server.banlock.RUnlock()

	for _, ban := range server.Bans {
		if ban.CertHash == hash && !ban.IsExpired() {
			return true
		}
	}

	return false
}

// Filter incoming text according to the server's current rules.
func (server *Server) FilterText(text string) (filtered string, err error) {
	options := &htmlfilter.Options{
		StripHTML:             !server.cfg.BoolValue("AllowHTML"),
		MaxTextMessageLength:  server.cfg.IntValue("MaxTextMessageLength"),
		MaxImageMessageLength: server.cfg.IntValue("MaxImageMessageLength"),
	}
	return htmlfilter.Filter(text, options)
}

// UpdateChannel save the channel state into database
func (server *Server) UpdateChannel(channel *Channel) (err error) {
	if channel.IsTemporary() {
		return nil
	}

	sid := uint64(server.Id)
	cid := uint64(channel.Id)

	tx := server.DB.Tx()
	defer tx.Commit()

	parentID := -1
	if channel.parent != nil {
		parentID = channel.parent.Id
	}
	err = tx.ChannelUpdate(sid, cid, channel.Name, int64(parentID), channel.ACL.InheritACL)
	if err != nil {
		tx.Rollback()
		return err
	}

	err = tx.ChannelInfoSet(sid, cid, map[database.ChannelInfoKey]string{
		database.ChannelDescription: channel.DescriptionBlob,
		database.ChannelPosition:    strconv.Itoa(channel.Position),
		database.ChannelMaxUsers:    strconv.Itoa(channel.MaxUsers),
	})
	if err != nil {
		tx.Rollback()
		return err
	}

	err = tx.GroupDeleteByChannel(sid, cid)
	if err != nil {
		tx.Rollback()
		return err
	}

	err = tx.ACLRemoveByChannel(sid, cid)
	if err != nil {
		tx.Rollback()
		return err
	}

	for name, group := range channel.ACL.Groups {
		g, err := tx.GroupAdd(sid, cid, name, group.Inherit, group.Inheritable)
		if err != nil {
			tx.Rollback()
			return err
		}

		for uid := range group.Add {
			err = tx.GroupMemberAdd(sid, g.GroupID, uint64(uid), true)
			if err != nil {
				tx.Rollback()
				return err
			}
		}

		for uid := range group.Remove {
			err = tx.GroupMemberAdd(sid, g.GroupID, uint64(uid), false)
			if err != nil {
				tx.Rollback()
				return err
			}
		}
	}

	priority := 5
	for _, acl := range channel.ACL.ACLs {
		dbacl := database.NewACL(sid, cid, priority).Apply(acl.ApplyHere, acl.ApplySubs).Grant(int(acl.Allow)).Revoke(int(acl.Deny))
		if acl.UserId >= 0 {
			dbacl = dbacl.WithUser(uint64(acl.UserId))
		}
		if acl.Group != "" {
			dbacl = dbacl.WithGroup(acl.Group)
		}

		err = tx.ACLAdd(dbacl)
		if err != nil {
			tx.Rollback()
			return err
		}

		priority++
	}

	return nil
}

// The accept loop of the server.
func (server *Server) acceptLoop(listener net.Listener) {
	defer server.netwg.Done()

	for {
		// New client connected
		conn, err := listener.Accept()
		if err != nil {
			if isTimeout(err) {
				continue
			} else {
				return
			}
		}

		// Remove expired bans
		server.RemoveExpiredBans()

		// Is the client IP-banned?
		if server.IsConnectionBanned(conn) {
			server.Printf("Rejected client %v: Banned", conn.RemoteAddr())
			err := conn.Close()
			if err != nil {
				server.Printf("Unable to close connection: %v", err)
			}
			continue
		}

		// Create a new client connection from our *tls.Conn
		// which wraps net.TCPConn.
		err = server.handleIncomingClient(conn)
		if err != nil {
			server.Printf("Unable to handle new client: %v", err)
			continue
		}
	}
}

// The isTimeout function checks whether a
// network error is a timeout.
func isTimeout(err error) bool {
	if e, ok := err.(net.Error); ok {
		return e.Timeout()
	}
	return false
}

// derefMediaInbound loads the active mediaInbound channel via the atomic
// pointer. Returns a nil channel when the server is shut down — selecting on
// a nil channel blocks forever, which is the right behaviour for the
// handlerLoop's select (Stop closes bye first to wake it up). MEDIUM #3.
func derefMediaInbound(p *atomic.Pointer[chan mediaInboundJob]) chan mediaInboundJob {
	ch := p.Load()
	if ch == nil {
		return nil
	}
	return *ch
}

// pendingReclaimTimeout is the safety-net window after which a session-pool
// reclaim is forced even if SessionEnded never arrived from media. Long
// enough to absorb a partition + reconnect; short enough that recycled
// sessions don't stall a busy vServer (HIGH #4).
const pendingReclaimTimeout = 10 * time.Second

// pendingReclaimSweepInterval is how often the pendingReclaim map is swept
// for entries older than pendingReclaimTimeout. Test code can override this
// via the package-level pendingReclaimSweepIntervalForTests hook to keep
// suites fast.
var pendingReclaimSweepInterval = 1 * time.Second

// reclaimPendingSession is called from handleMediaInbound's SessionEnded
// path. It returns the session to the pool if it was actually pending; a
// session that was already reclaimed by the sweeper (or never entered the
// pending map at all) is a no-op.
func (server *Server) reclaimPendingSession(session uint32) {
	if server.pendingReclaim == nil {
		return
	}
	if _, ok := server.pendingReclaim[session]; !ok {
		return
	}
	delete(server.pendingReclaim, session)
	if server.pool != nil {
		server.pool.Reclaim(session)
	}
}

// sweepPendingReclaims forcibly reclaims any pendingReclaim entries older
// than pendingReclaimTimeout. Runs on the handlerLoop goroutine so it can
// touch server.pool / server.pendingReclaim without locking.
func (server *Server) sweepPendingReclaims() {
	if server.pendingReclaim == nil {
		return
	}
	now := time.Now()
	for session, ts := range server.pendingReclaim {
		if now.Sub(ts) <= pendingReclaimTimeout {
			continue
		}
		server.Printf("WebRTC: pending reclaim for session %d timed out; reclaiming", session)
		delete(server.pendingReclaim, session)
		if server.pool != nil {
			server.pool.Reclaim(session)
		}
	}
}

// recordMediaInboundDrop is invoked from the sidechannel goroutine when the
// per-vServer mediaInbound channel is full. Atomic so the read on Stop()/
// introspection paths is race-free.
func (server *Server) recordMediaInboundDrop() {
	atomic.AddUint64(&server.mediaInboundDropped, 1)
}

// MediaInboundDropped returns the cumulative drop count for visibility in
// tests / ops queries. Atomic load — safe from any goroutine.
func (server *Server) MediaInboundDropped() uint64 {
	return atomic.LoadUint64(&server.mediaInboundDropped)
}

// Initialize the per-launch data
func (server *Server) initPerLaunchData() {
	server.pool = sessionpool.New()
	server.clients = make(map[uint32]*Client)

	server.bye = make(chan bool)
	server.stopCh = make(chan struct{})
	server.incoming = make(chan *Message)
	server.tempRemove = make(chan *Channel, 1)
	server.clientAuthenticated = make(chan *Client)
	// mediaInbound buffer of 512 absorbs renegotiation bursts when a fresh
	// session joins a populated room (each existing peer gets a fresh
	// SDP-offer envelope, see CRITICAL #3). HIGH #1: when the buffer fills
	// we DROP the envelope rather than block the sidechannel goroutine —
	// one stalled vServer must not wedge the whole fleet. The drop is
	// counted and visible via MediaInboundDropped() for ops alerting.
	mi := make(chan mediaInboundJob, 512)
	server.mediaInbound.Store(&mi)
	server.pendingReclaim = make(map[uint32]time.Time)
	atomic.StoreUint64(&server.mediaInboundDropped, 0)
}

// Clean per-launch data
func (server *Server) cleanPerLaunchData() {
	server.pool = nil
	server.clients = nil

	server.bye = nil
	server.stopCh = nil
	server.incoming = nil
	server.tempRemove = nil
	server.mediaInbound.Store(nil)
	server.clientAuthenticated = nil
	server.pendingReclaim = nil
}

// Port returns the port the native server will listen on when it is
// started.
func (server *Server) Port() int {
	port := server.cfg.IntValue("Port")
	if port == 0 {
		return DefaultPort + int(server.Id) - 1
	}
	return port
}

// ListenWebPort returns true if we should listen to the
// web port, otherwise false
func (server *Server) ListenWebPort() bool {
	return !server.cfg.BoolValue("NoWebServer")
}

// WebPort returns the port the web server will listen on when it is
// started.
func (server *Server) WebPort() int {
	port := server.cfg.IntValue("WebPort")
	if port == 0 {
		return DefaultWebPort + int(server.Id) - 1
	}
	return port
}

// CurrentPort returns the port the native server is currently listening
// on.  If called when the server is not running,
// this function returns -1.
func (server *Server) CurrentPort() int {
	if !server.running {
		return -1
	}
	tcpaddr := server.tcpl.Addr().(*net.TCPAddr)
	return tcpaddr.Port
}

// HostAddress returns the host address the server will listen on when
// it is started. This must be an IP address, either IPv4
// or IPv6.
func (server *Server) HostAddress() string {
	host := server.cfg.StringValue("Address")
	if host == "" {
		return "0.0.0.0"
	}
	return host
}

// Start the server.
func (server *Server) Start() (err error) {
	if server.running {
		return errors.New("already running")
	}

	host := server.HostAddress()
	port := server.Port()
	shouldListenWeb := server.ListenWebPort()

	// The native Mumble UDP voice listener retired in phase 1 step 3 — voice
	// flows over WebRTC now (DTLS-SRTP terminates encryption). Control listens
	// on TCP/TLS + WSS only; the TCP listener does double duty for the WebSocket
	// upgrade on the same port via media.Sniff (see below).

	// Set up our TCP connection
	server.tcpl, err = net.ListenTCP("tcp", &net.TCPAddr{IP: net.ParseIP(host), Port: port})
	if err != nil {
		return err
	}
	/*
		err = server.tcpl.SetTimeout(1e9)
		if err != nil {
			return err
		}
	*/

	// Load the TLS cert/key shared by both the Mumble TLS path and the
	// HTTP/WebSocket upgrade path.
	certFn := filepath.Join(server.DataDir, "cert.pem")
	keyFn := filepath.Join(server.DataDir, "key.pem")
	cert, err := tls.LoadX509KeyPair(certFn, keyFn)
	if err != nil {
		return err
	}
	server.tlscfg = &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequestClientCert,
	}

	// SFU now runs in hachiman-media — control is the signaling shim. WebRTC
	// SDP messages arriving over Mumble TCP get forwarded to the assigned
	// media node via the MediaControl sidechannel (see webrtc_handlers.go).

	if shouldListenWeb {
		// Multiplex TLS and HTTP/WebSocket on the same TCP port by sniffing
		// the first byte of each connection. 0x16 = TLS ContentType Handshake;
		// anything else is treated as an HTTP request for the WS upgrade.
		tlsBranch, wsBranch, stopSniff := wssSniff(server.tcpl, server.Logger)
		server.sniffStop = stopSniff
		server.tlsl = tls.NewListener(tlsBranch, server.tlscfg)

		server.webtlscfg = &tls.Config{
			Certificates: []tls.Certificate{cert},
			ClientAuth:   tls.NoClientCert,
			NextProtos:   []string{"http/1.1"},
		}
		server.webwsl = newWSListener(server.tcpl.Addr(), server.Logger)
		mux := http.NewServeMux()
		// Relay thin/on-path metrics are now served over the
		// authenticated Mumble control channel (RelayMetricsQuery ->
		// RelayMetricsSnapshot, see handleRelayMetricsQuery), gated on
		// SuperUser / root-channel Write. The previous unauthenticated
		// GET /metrics/relay mount was globally reachable on the shared
		// HTTP/WS port with no client identity to gate on, so it has been
		// removed rather than left open or bolted onto with brittle HTTP
		// auth. RelayMetrics.ServeHTTP is retained for an operator who
		// wants to mount it behind their own private/localhost listener.
		mux.Handle("/", server.webwsl)

		server.webhttp = &http.Server{
			Handler:  mux,
			ErrorLog: server.Logger,

			// Set sensible timeouts, in case no reverse proxy is in front of Grumble.
			// Non-conforming (or malicious) clients may otherwise block indefinitely and cause
			// file descriptors (or handles, depending on your OS) to leak and/or be exhausted
			ReadTimeout:  5 * time.Second,
			WriteTimeout: 10 * time.Second,
			IdleTimeout:  2 * time.Minute,
		}
		go func() {
			err := server.webhttp.Serve(wsBranch)
			if err != http.ErrServerClosed {
				server.Fatalf("Fatal HTTP server error: %v", err)
			}
		}()
	} else {
		// Web disabled — bind TLS directly to the raw TCP listener.
		server.tlsl = tls.NewListener(server.tcpl, server.tlscfg)
	}

	server.Printf("Started: listening on %v", server.tcpl.Addr())

	server.running = true

	// Reset the server's per-launch data to
	// a clean state.
	server.initPerLaunchData()

	// Launch the event handler goroutine
	go server.handlerLoop()

	// Add the network receiver goroutines to the net waitgroup and launch
	// them. We use the waitgroup to provide a blocking Stop() method for the
	// servers — each network goroutine defers netwg.Done(). Stop() closes
	// all connections and calls netwg.Wait() to wait for them to end. UDP
	// listener removed in phase 1 step 3.
	numWG := 1
	if shouldListenWeb {
		numWG++
	}

	server.netwg.Add(numWG)
	go server.acceptLoop(server.tlsl)
	if shouldListenWeb {
		go server.acceptLoop(server.webwsl)
	}

	// Schedule a server registration update (if needed). Watch stopCh so a
	// runtime DeleteVirtualServer (via the management API) doesn't leak this
	// goroutine for up to a minute after the server is gone.
	go func() {
		select {
		case <-time.After(1 * time.Minute):
			server.RegisterPublicServer()
		case <-server.stopCh:
			return
		}
	}()

	return nil
}

// Stop the server.
func (server *Server) Stop() (err error) {
	if !server.running {
		return errors.New("server not running")
	}

	// Signal any per-server goroutines outside the bye/netwg path (the
	// deferred RegisterPublicServer timer) to exit. Closed-channel
	// signaling is cheap and idempotent — Stop() never runs twice
	// concurrently thanks to the !running guard above.
	close(server.stopCh)

	// Stop the handler goroutine and disconnect all
	// clients
	server.bye <- true
	for _, client := range server.clients {
		client.Disconnect()
	}

	if server.ListenWebPort() {
		// Wait for the HTTP server to shutdown gracefully
		// A client could theoretically block the server from ever stopping by
		// never letting the HTTP connection go idle, so we give 15 seconds of grace time.
		// This does not apply to opened WebSockets, which were forcibly closed when
		// all clients were disconnected.
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(15*time.Second))
		err = server.webhttp.Shutdown(ctx)
		cancel()
		if err == context.DeadlineExceeded {
			server.Println("Forcibly shutdown HTTP server while stopping")
		} else if err != nil {
			return err
		}

		// Close the wsListener instance that was mounted on the HTTP mux
		// as a Handler (`mux.Handle("/", server.webwsl)`). This is the FIRST
		// and only close of this listener — webhttp.Shutdown above closed
		// webhttp's OWN listener (the wsBranch from wssSniff), which is a
		// different object. No double-close tolerance is needed here.
		err = server.webwsl.Close()
		if err != nil {
			return err
		}

		if server.sniffStop != nil {
			server.sniffStop()
		}
	}

	// Close the listeners. tlsl wraps the tlsBranch from wssSniff, which
	// sniffStop above already closed — its Close will return
	// errClosedSniffListener in that case. Same tolerance reasoning as the
	// webwsl close above.
	err = server.tlsl.Close()
	if err != nil && !errors.Is(err, errClosedSniffListener) {
		return err
	}

	// Wait for the network receiver goroutines to exit.
	server.netwg.Wait()

	server.cleanPerLaunchData()
	server.running = false
	server.Printf("Stopped")

	return nil
}

// Set will set a configuration value
func (server *Server) Set(key string, value string) {
	server.cfg.Set(key, value)
}

// ValidateUsername will check if specified user name is validate
func (server *Server) ValidateUsername(name string) bool {
	return len(name) > 0 && len(name) < 128
}

// ValidateChannelName will check if specified channel name is validate
func (server *Server) ValidateChannelName(name string) bool {
	return len(name) > 0 && len(name) < 128
}

// CanNest check if a channel can be set as a parent
func (server *Server) CanNest(parent, channel *Channel) bool {
	parentLevel := -1
	channelDepth := 0
	if parent != nil {
		parentLevel = parent.Level()
	}
	if channel != nil {
		channelDepth = channel.Depth()
	}

	limit := server.cfg.IntValue("ChannelNestingLimit")
	return parentLevel+channelDepth < limit
}

func (server *Server) ChannelReachLimit() bool {
	limit := server.cfg.IntValue("ChannelCountLimit")
	if limit > 0 && len(server.Channels) >= limit {
		return true
	}
	return false
}

func (server *Server) IsChannelFull(channel *Channel, user acl.User) bool {
	if user != nil && acl.HasPermission(&channel.ACL, user, acl.WritePermission) {
		return false
	}
	if channel.MaxUsers > 0 {
		return len(channel.clients) >= channel.MaxUsers
	}
	globalLimit := server.cfg.IntValue("MaxUsersPerChannel")
	if globalLimit > 0 {
		return len(channel.clients) >= globalLimit
	}
	return false
}

func (server *Server) SetChannelListenerVolume(client *Client, channel *Channel, volume float32) error {
	if client.user == nil {
		return nil
	}

	tx := server.DB.Tx()
	defer tx.Commit()

	return tx.ChannelListenerSetVolume(uint64(server.Id), uint64(client.UserId()), uint64(channel.Id), volume)
}

func (server *Server) AddChannelListener(client *Client, channel *Channel) error {
	if client.user == nil {
		return nil
	}

	tx := server.DB.Tx()
	defer tx.Commit()

	_, err := tx.ChannelListenerAdd(uint64(server.Id), uint64(client.UserId()), uint64(channel.Id))
	return err
}

func (server *Server) DisableChannelListener(client *Client, channel *Channel) error {
	if client.user == nil {
		return nil
	}

	tx := server.DB.Tx()
	defer tx.Commit()

	err := tx.ChannelListenerSetEnabled(uint64(server.Id), uint64(client.UserId()), uint64(channel.Id), false)
	return err
}

// defaultQualityProfile returns the seeded `Hachiman-Standard` profile that
// matches the Quality Targets section of MEDIA-PLANE-MIGRATION.md. Used at
// `ServerSync` time so clients without a WebRTC voice token still get codec
// / ladder / jitter configuration; the persistent per-channel / per-server
// override path (`quality_profiles` table) lands with phase 1 step 9. This
// stand-in is intentionally hand-stamped — it documents on the wire what
// the eventual seed row will contain.
func defaultQualityProfile() *mumbleproto.QualityProfile {
	return &mumbleproto.QualityProfile{
		ProfileId:             proto.Uint32(0), // 0 = ad-hoc / inline (no DB row yet)
		Name:                  proto.String("Hachiman-Standard"),
		VoiceCodec:            proto.String("opus"),
		VoiceBitrateMin:       proto.Uint32(64000),
		VoiceBitrateMax:       proto.Uint32(96000),
		VoicePtimeMs:          proto.Uint32(10),
		VoiceFec:              proto.Bool(true),
		VoiceDtx:              proto.Bool(false),
		JitterTargetMs:        proto.Uint32(20),
		JitterMaxMs:           proto.Uint32(40),
		ScreenCodecs:          []string{"av1", "vp9", "vp8"},
		ScreenLadder:          []string{"1080p60", "720p30", "480p15"},
		RequiresRenegotiation: proto.Bool(false),
	}
}
