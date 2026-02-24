#!/bin/bash

if [[ -z `which node` ]]; then
  curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
  sudp apt update
  sudo apt install -y nodejs
  sudo mkdir -p "/root/.npm"
  sudo chmod 777 "/root"
  sudo chmod 777 "/root/.npm"

  sudo npm i -g npm@latest yarn@latest mythix-cli
fi
