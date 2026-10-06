/**
 * The MlsRepo conformance suite on InMemoryMlsRepo (no database).
 */
import { describeMlsRepo } from './repo.conformance'
import { InMemoryMlsRepo } from './repo.in-memory'

describeMlsRepo('InMemoryMlsRepo', async () => {
  const repo = new InMemoryMlsRepo()
  return {
    repo,
    fx: {
      async addUser() {
        return repo.addUser()
      },
      async addGuild(ownerId, everyonePermissions = 0) {
        return repo.addGuild(ownerId, undefined, everyonePermissions)
      },
      async addRole(guildId, permissions) {
        return repo.addRole(guildId, permissions)
      },
      async addGuildMember(guildId, userId, roleIds = []) {
        repo.addGuildMember(guildId, userId, roleIds)
      },
      async addChannel(c) {
        return repo.addChannel(c)
      },
      async setOverwrites(channelId, ows) {
        repo.setOverwrites(channelId, ows)
      },
      async addDm(participants) {
        return repo.addDm(participants)
      },
      async addInvite(i) {
        return repo.addInvite(i)
      },
      async addInviteMember(guildId, userId, inviteId, joinedAt) {
        repo.addInviteMember(guildId, userId, inviteId, joinedAt)
      },
    },
  }
})
