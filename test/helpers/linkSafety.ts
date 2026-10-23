import {expect} from "chai";
import {judgeLink} from "../../client/js/helpers/linkSafety";

describe("linkSafety (masked markdown links)", function () {
	describe("judgeLink", function () {
		it("flags a label that names another host", function () {
			expect(judgeLink("paypal.com", "https://evil.example/login")).to.deep.equal({
				kind: "mismatch",
				host: "evil.example",
				shown: "paypal.com",
			});
		});

		it("flags a label host that is only a prefix of the real one", function () {
			expect(judgeLink("https://paypal.com", "https://paypal.com.evil.io/")).to.deep.equal({
				kind: "mismatch",
				host: "paypal.com.evil.io",
				shown: "https://paypal.com",
			});
		});

		it("sees through userinfo before the host", function () {
			expect(judgeLink("bank.com", "https://bank.com@evil.example/")).to.deep.equal({
				kind: "mismatch",
				host: "evil.example",
				shown: "bank.com",
			});
		});

		it("lets a label on the same host with another path through", function () {
			expect(judgeLink("https://github.com/foo", "https://github.com/evil")).to.deep.equal({
				kind: "honest",
			});
		});

		it("ignores a www. prefix and letter case", function () {
			expect(judgeLink("www.GitHub.com", "https://github.com/x")).to.deep.equal({
				kind: "honest",
			});
		});

		it("shows the host when the link goes to a subdomain of the labelled one", function () {
			// The label names the parent: a shared host (github.io, co.uk) is
			// anyone's parent, so the real host is shown, though not as a lie.
			expect(judgeLink("github.com", "https://gist.github.com/x")).to.deep.equal({
				kind: "masked",
				host: "gist.github.com",
			});
			expect(judgeLink("github.io", "https://attacker.github.io/")).to.deep.equal({
				kind: "masked",
				host: "attacker.github.io",
			});
			expect(judgeLink("co.uk", "https://evil.co.uk/")).to.deep.equal({
				kind: "masked",
				host: "evil.co.uk",
			});
		});

		it("shows the host when the label names a subdomain of the real one", function () {
			// A shared host (s3.amazonaws.com/attacker) is anyone's, so a label
			// naming a site under it claims more than the link proves.
			expect(judgeLink("login.paypal.com", "https://paypal.com/")).to.deep.equal({
				kind: "masked",
				host: "paypal.com",
			});
			expect(
				judgeLink("paypal.s3.amazonaws.com", "https://s3.amazonaws.com/attacker")
			).to.deep.equal({kind: "masked", host: "s3.amazonaws.com"});
		});

		it("is not fooled by invisible characters or emoji glued to the label's domain", function () {
			for (const label of [
				"paypal.com\u200b",
				"paypal.com\u200c",
				"paypal.com\u200e",
				"paypal.com\u2060",
				"paypal.com\u00ad",
				"paypal.com🔒",
				"www.paypal.com✅",
				"pay\u200cpal.com",
				"https://paypal.com\u200e/login",
				// Spaces too thin to see: NFKC would make them a gap.
				"paypal.c\u200aom",
				"paypal.c\u2009om",
				"paypal\u202f.com",
				"paypal.c\u205fom",
				// A combining mark is part of its letter, not a break.
				"paypal.c\u0323om",
				// Punctuation in front that no letter precedes.
				".paypal.com",
				"Verify…paypal.com",
				"Login...paypal.com",
				"-paypal.com",
				"+paypal.com",
			]) {
				expect(
					judgeLink(label, "https://evil.example/login").kind,
					JSON.stringify(label)
				).to.equal("mismatch");
			}
		});

		it("is not fooled by lookalike dots or letters in the label's domain", function () {
			for (const label of [
				"paypal\u2024com",
				"paypal\uff0ecom",
				"paypal\u3002com",
				"paypal.c\u043em",
			]) {
				expect(
					judgeLink(label, "https://evil.example/login").kind,
					JSON.stringify(label)
				).to.equal("mismatch");
			}
		});

		it("never takes a word with a path for a file name", function () {
			expect(judgeLink("docs.rs/serde", "https://evil.example/").kind).to.equal("mismatch");
		});

		it("calls a label that is the URL honest", function () {
			expect(judgeLink("https://x.org/a", "https://x.org/a")).to.deep.equal({kind: "honest"});
		});

		it("shows the host of a prose label", function () {
			expect(judgeLink("click here", "https://example.org/p")).to.deep.equal({
				kind: "masked",
				host: "example.org",
			});
		});

		it("shows a lookalike host in punycode", function () {
			const verdict = judgeLink("click here", "https://раypal.com/");
			expect(verdict.kind).to.equal("masked");
			expect(verdict.kind === "masked" && verdict.host).to.match(/^xn--/);
		});

		it("shows the server of a web+irc link", function () {
			expect(judgeLink("#help", "web+irc://irc.evil.example/#help")).to.deep.equal({
				kind: "masked",
				host: "irc.evil.example",
			});
		});

		it("flags an address inside a longer label", function () {
			const verdict = judgeLink("see paypal.com and docs", "https://evil.example");
			expect(verdict.kind).to.equal("mismatch");
			expect(verdict.kind === "mismatch" && verdict.shown).to.equal("paypal.com");
		});

		it("does not let a label pass by matching the link's own path", function () {
			expect(judgeLink("paypal.com", "https://evil.example/paypal.com").kind).to.equal(
				"mismatch"
			);
			expect(
				judgeLink("Verify at paypal.com", "https://evil.example/paypal.com").kind
			).to.equal("mismatch");
		});

		it("does not take a source file name for an address", function () {
			for (const label of ["readme.md", "setup.py", "main.rs", "install.sh"]) {
				expect(judgeLink(label, "https://github.com/org/repo"), label).to.deep.equal({
					kind: "masked",
					host: "github.com",
				});
			}
		});

		it("takes a real site under an extension-like TLD for an address", function () {
			for (const label of [
				"Sign in at claude.ai",
				"notion.so",
				"allegro.pl",
				"backup.zip",
				"8.8.8.8",
			]) {
				expect(judgeLink(label, "https://evil.example/").kind, label).to.equal("mismatch");
			}
		});

		it("never takes a file-name-shaped word with a scheme, userinfo or www. for a file name", function () {
			for (const label of [
				"https://setup.py",
				"www.readme.md",
				"x@paypal.rs",
				"https://ASP.NET",
				"www.Socket.IO",
			]) {
				expect(judgeLink(label, "https://evil.example/").kind, label).to.equal("mismatch");
			}
		});

		it("reads a TLD written in capitals as a name, not an address", function () {
			for (const [label, href] of [
				["ASP.NET docs", "https://learn.microsoft.com/"],
				["Socket.IO", "https://github.com/socketio/socket.io"],
			]) {
				expect(judgeLink(label, href).kind, label).to.equal("masked");
			}

			for (const label of ["PayPal.com", "PayPal.Com"]) {
				expect(judgeLink(label, "https://evil.example/").kind, label).to.equal("mismatch");
			}
		});

		it("lets an IDN in a script with combining marks through on its own site", function () {
			expect(judgeLink("उदाहरण.भारत", "https://उदाहरण.भारत/")).to.deep.equal({
				kind: "honest",
			});
		});

		it("reads a long label in linear time", function () {
			const label = "a".repeat(16000);
			const start = Date.now();
			judgeLink(label, "https://x.example/");
			judgeLink("a,".repeat(8000), "https://x.example/");
			judgeLink("a.".repeat(8000) + "a", "https://x.example/");
			expect(Date.now() - start).to.be.below(100);
		});

		it("flags an e-mail label whose domain is not where the link goes", function () {
			expect(judgeLink("support@paypal.com", "https://evil.example/")).to.deep.equal({
				kind: "mismatch",
				host: "evil.example",
				shown: "support@paypal.com",
			});
			// `.example` is no TLD, so a real one: only a real TLD names a site.
			expect(judgeLink("help@example.com", "https://example.com/")).to.deep.equal({
				kind: "honest",
			});
		});

		it("treats an href it cannot parse as masked, showing it whole", function () {
			expect(judgeLink("x", "https://")).to.deep.equal({kind: "masked", host: "https://"});
		});
	});
});
