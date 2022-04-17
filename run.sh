#!/bin/bash
if [ $1 == "--cancel" ]
then
    . cancel.env
    yarn cancel
elif [ $1 == "--wash" ]
then
    . wash.env
    yarn wash
fi
