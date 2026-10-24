# Browser VS Code (server in Linux) with Sidestory installed and the sample workspace copied in.
# Pinned so a new VS Code release can't change the tests underneath us (1.105.1).
FROM gitpod/openvscode-server@sha256:5e7b8750749f282940a799ed59ccd02fac698ef6744f9113ac01c0ef8e76485e
# Lets the test setup find and remove this image's stale copies (only ours).
LABEL org.sidestory.test=e2e
USER root
COPY dist/sidestory.vsix /tmp/sidestory.vsix
COPY fixtures/sample-workspace /home/workspace/sample
COPY fixtures/sample-workspace /home/workspace/.fixture
# A second, larger package (docs/NAVIGATION-PLAN.md §12.3): stream-dma, beside services/auth.
COPY examples/stream-dma/.sidestory /home/workspace/sample/stream-dma/.sidestory
COPY examples/stream-dma/rtl /home/workspace/sample/stream-dma/rtl
COPY examples/stream-dma/.sidestory /home/workspace/.fixture/stream-dma/.sidestory
COPY examples/stream-dma/rtl /home/workspace/.fixture/stream-dma/rtl
# The Changes view's fixture (docs/CHANGES-PLAN.md §16.3): a branch with A/M/D/R changes and a main that moved on
# after the fork. Needs git in the image; tests copy the pristine fixture to /home/workspace/chg.
COPY test/fixtures/git-repo.mjs /tmp/git-repo.mjs
RUN (command -v git >/dev/null || (apt-get update -q && apt-get install -yq --no-install-recommends git && rm -rf /var/lib/apt/lists/*)) \
  && ${OPENVSCODE_SERVER_ROOT}/node /tmp/git-repo.mjs /home/workspace/.chg-fixture
COPY test/e2e/settings.json /home/workspace/.openvscode-server/data/Machine/settings.json
COPY test/e2e/settings.json /home/workspace/.openvscode-server/data/User/settings.json
COPY test/e2e/settings.json /home/workspace/.settings.json
RUN chown -R openvscode-server:openvscode-server /home/workspace
USER openvscode-server
RUN ${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server --install-extension /tmp/sidestory.vsix
