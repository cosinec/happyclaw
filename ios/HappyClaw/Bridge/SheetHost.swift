import HappyClawCore
import SwiftUI

/// Native sheets (medium/large detents with grabber). MVP hosts the 「更多」
/// list: web-declared overflow pages plus shell-owned App entries. Complex
/// business dialogs stay inside the web view (decision D4).
enum ShellSheet: Identifiable {
  case more
  /// A file the web downloaded, offered through the system share sheet.
  case share(URL)

  var id: String {
    switch self {
    case .more: "more"
    case let .share(file): "share:\(file.path)"
    }
  }
}

struct MoreSheet: View {
  let items: [TabDeclaration]
  let selectedId: String?
  let onSelectPage: (TabDeclaration) -> Void
  let onOpenRoute: (ShellRoute) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        Section(L10n.morePagesSection) {
          ForEach(items) { item in
            Button {
              dismiss()
              onSelectPage(item)
            } label: {
              HStack {
                Label(item.title, systemImage: item.symbol)
                Spacer()
                if item.id == selectedId {
                  Image(systemName: "checkmark").foregroundStyle(.tint)
                }
              }
            }
            .foregroundStyle(.primary)
          }
        }
        Section(L10n.moreAppSection) {
          Button {
            dismiss()
            onOpenRoute(.serverSettings)
          } label: {
            Label(L10n.moreServer, systemImage: "server.rack")
          }
          Button {
            dismiss()
            onOpenRoute(.diagnostics)
          } label: {
            Label(L10n.moreDiagnostics, systemImage: "stethoscope")
          }
        }
        .foregroundStyle(.primary)
      }
      .navigationTitle(L10n.moreTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(L10n.done) { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}
