# Homebrew formula. Install with:
#   brew tap pshen44/claude-image-gen https://github.com/pshen44/claude-image-gen
#   brew trust pshen44/claude-image-gen
#   brew install claude-image-gen
class ClaudeImageGen < Formula
  desc "Generate images and videos with Google Flow from the command-line"
  homepage "https://github.com/pshen44/claude-image-gen"
  url "https://raw.githubusercontent.com/pshen44/claude-image-gen/v0.3.0/claude-image-gen.js"
  sha256 "7939630fd7d4e4fb3963da8c0d0d17c21c606e6b42f527b73bd548d78fac7ba3"
  license "MIT"

  depends_on "node"

  def install
    libexec.install "claude-image-gen.js"
    (bin/"claude-image-gen").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/claude-image-gen.js" "$@"
    SH
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/claude-image-gen --version").strip
  end
end
