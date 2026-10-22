import {expect} from "chai";
import {judgeLink, linkHost} from "../../client/js/helpers/linkSafety";

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

		it("lets a subdomain of the labelled host through", function () {
			expect(judgeLink("github.com", "https://gist.github.com/x")).to.deep.equal({
				kind: "honest",
			});
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

		it("does not take a file name in the link's own path for an address", function () {
			expect(
				judgeLink("setup.py", "https://github.com/org/repo/blob/main/setup.py")
			).to.deep.equal({kind: "masked", host: "github.com"});
		});

		it("does not take a bare file name for an address", function () {
			for (const label of [
				"readme.md",
				"backup.zip",
				"main.rs",
				"demo.mov",
				"script.sh",
				"lib.so",
			]) {
				expect(judgeLink(label, "https://github.com/org/repo"), label).to.deep.equal({
					kind: "masked",
					host: "github.com",
				});
			}
		});

		it("still flags an extension-like domain written with a scheme or www.", function () {
			expect(judgeLink("https://paypal.zip", "https://evil.example/").kind).to.equal(
				"mismatch"
			);
			expect(judgeLink("www.paypal.zip", "https://evil.example/").kind).to.equal("mismatch");
		});

		it("flags an e-mail label whose domain is not where the link goes", function () {
			expect(judgeLink("support@paypal.com", "https://evil.example/")).to.deep.equal({
				kind: "mismatch",
				host: "evil.example",
				shown: "support@paypal.com",
			});
			// `.example` is no TLD, so a real one: the linkifier only finds real domains.
			expect(judgeLink("help@example.com", "https://example.com/")).to.deep.equal({
				kind: "honest",
			});
		});

		it("treats an href it cannot parse as masked, showing it whole", function () {
			expect(judgeLink("x", "https://")).to.deep.equal({kind: "masked", host: "https://"});
		});
	});

	describe("linkHost", function () {
		it("lowercases and drops a trailing dot", function () {
			expect(linkHost("https://Example.ORG./a")).to.equal("example.org");
		});

		it("returns undefined for something that is not a URL", function () {
			expect(linkHost("not a url")).to.equal(undefined);
		});
	});
});
