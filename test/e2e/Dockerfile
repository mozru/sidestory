# Browser VS Code (server in Linux) with Code Explainer installed and the sample workspace copied in.
# Pinned so a new VS Code release can't change the tests underneath us (1.105.1).
FROM gitpod/openvscode-server@sha256:5e7b8750749f282940a799ed59ccd02fac698ef6744f9113ac01c0ef8e76485e
# Lets the test setup find and remove this image's stale copies (only ours).
LABEL org.code-explainer.test=e2e
USER root
COPY dist/code-explainer.vsix /tmp/code-explainer.vsix
COPY fixtures/sample-workspace /home/workspace/sample
COPY fixtures/sample-workspace /home/workspace/.fixture
COPY test/e2e/settings.json /home/workspace/.openvscode-server/data/Machine/settings.json
COPY test/e2e/settings.json /home/workspace/.openvscode-server/data/User/settings.json
COPY test/e2e/settings.json /home/workspace/.settings.json
RUN chown -R openvscode-server:openvscode-server /home/workspace
USER openvscode-server
RUN ${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server --install-extension /tmp/code-explainer.vsix
