import HappyClawCore
import SwiftUI

/// First-launch address entry, also pushed from 「更多 → 服务器地址」.
struct ConnectView: View {
  let isSettings: Bool
  let onConnect: (ServerAddress) -> Void
  @State private var input: String
  @State private var error: String?
  @Environment(\.dismiss) private var dismiss

  init(initial: ServerAddress?, isSettings: Bool, onConnect: @escaping (ServerAddress) -> Void) {
    self.isSettings = isSettings
    self.onConnect = onConnect
    _input = State(initialValue: initial?.displayString ?? "")
  }

  var body: some View {
    Form {
      if !isSettings {
        Section {
          VStack(spacing: 12) {
            Image(systemName: "pawprint.circle.fill")
              .font(.system(size: 56))
              .foregroundStyle(.tint)
            Text(L10n.connectHeadline)
              .font(.title3.weight(.semibold))
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
          .listRowBackground(Color.clear)
        }
      }
      Section {
        TextField(L10n.connectFieldPlaceholder, text: $input)
          .keyboardType(.URL)
          .textContentType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.go)
          .onSubmit(submit)
      } header: {
        Text(L10n.connectFieldLabel)
      } footer: {
        VStack(alignment: .leading, spacing: 6) {
          if let error {
            Text(error).foregroundStyle(.red)
          }
          Text(L10n.connectFooter)
        }
      }
      Section {
        Button(isSettings ? L10n.connectSaveButton : L10n.connectButton, action: submit)
          .frame(maxWidth: .infinity)
          .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
    .navigationTitle(L10n.connectTitle)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(isSettings ? .visible : .hidden, for: .navigationBar)
  }

  private func submit() {
    do {
      let address = try ServerAddress(parsing: input)
      error = nil
      onConnect(address)
      if isSettings { dismiss() }
    } catch .empty {
      error = L10n.connectErrorEmpty
    } catch .unsupportedScheme {
      error = L10n.connectErrorScheme
    } catch {
      self.error = L10n.connectErrorInvalid
    }
  }
}
