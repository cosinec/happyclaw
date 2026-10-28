import HappyClawCore
import SwiftUI

/// 「更多 → 服务器」: saved servers, the active one checked. Tapping one
/// switches to it (its own login and data); swiping removes an inactive one
/// after confirmation, together with its web data on this device.
struct ServerListView: View {
  let model: ShellModel
  @State private var pendingRemoval: ServerInstance?

  var body: some View {
    List {
      Section {
        ForEach(model.registry.instances) { instance in
          let active = instance.id == model.registry.activeID
          Button {
            model.switchServer(to: instance.id)
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(instance.address.url.host() ?? instance.address.displayString)
                  .foregroundStyle(.primary)
                Text(instance.address.displayString)
                  .font(.footnote)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              if active {
                Image(systemName: "checkmark").foregroundStyle(.tint)
                  .accessibilityLabel(L10n.serverCurrent)
              }
            }
          }
          .swipeActions {
            if !active {
              Button(L10n.serverRemove, systemImage: "trash", role: .destructive) {
                pendingRemoval = instance
              }
            }
          }
        }
      } footer: {
        Text(L10n.serverListFooter)
      }
      Section {
        NavigationLink(value: ShellRoute.addServer) {
          Label(L10n.serverAdd, systemImage: "plus")
        }
      }
    }
    .navigationTitle(L10n.serverListTitle)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.visible, for: .navigationBar)
    .confirmationDialog(
      L10n.serverRemoveTitle,
      isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
      titleVisibility: .visible,
      presenting: pendingRemoval
    ) { instance in
      Button(L10n.serverRemove, role: .destructive) { model.removeServer(instance.id) }
    } message: { _ in
      Text(L10n.serverRemoveMessage)
    }
  }
}
