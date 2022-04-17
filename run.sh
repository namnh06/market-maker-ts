#!/bin/bash
if [ $1 == "--cancel" ]
then
    . cancel.env
    yarn cancel
fi
