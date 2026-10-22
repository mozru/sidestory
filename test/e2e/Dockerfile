# Browser VS Code (server in Linux) with Code Explainer installed and the sample workspace copied in.
FROM gitpod/openvscode-server:latest
USER root
COPY dist/code-explainer.vsix /tmp/code-explainer.vsix
COPY fixtures/sample-workspace /home/workspace/sample
COPY test/e2e/settings.json /home/workspace/.openvscode-server/data/Machine/settings.json
COPY test/e2e/settings.json /home/workspace/.openvscode-server/data/User/settings.json
RUN chown -R openvscode-server:openvscode-server /home/workspace
USER openvscode-server
RUN ${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server --install-extension /tmp/code-explainer.vsix
